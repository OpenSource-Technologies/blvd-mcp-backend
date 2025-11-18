// src/chat/chat.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import OpenAI from 'openai';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface SessionState {
  threadId?: string;
  cartId?: string;
  serviceItemId?: string;
  bookableTimeId?: string;
  staffVariantId?: string;
  promotionOfferId?: string;
  clientEmail?: string;
  totalAmount?: number;
  awaitingClientDetails?: boolean;
  messageCount?: number; // Track message count for thread cleanup
}

@Injectable()
export class ChatService implements OnModuleInit {
  private openai: any;
  private mcpClient!: MCPClient;
  private transport!: any;

  private assistantId: string | null = null;
  private sessionState: Record<string, SessionState> = {};
  private creatingThread: Record<string, Promise<string>> = {};

  // ⚙️ Configuration
  private readonly MAX_MESSAGES_PER_THREAD = 8; // Reset thread after 20 messages
  private readonly POLL_INTERVAL_MS = 2000; // Slower polling = fewer API calls
  private readonly MAX_POLL_ATTEMPTS = 30;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  private async initMCP() {
    this.transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/appointment-booking.js'],
      stderr: 'inherit',
    });

    this.transport.process?.stdout?.on('data', (d: Buffer) => 
      console.log('🪶 [MCP STDOUT]:', d.toString().trim())
    );
    this.transport.process?.stderr?.on('data', (d: Buffer) => 
      console.error('🔥 [MCP STDERR]:', d.toString().trim())
    );

    this.mcpClient = new MCPClient({ name: 'blvd-mcp-client', version: '1.1.0' });
    await this.mcpClient.connect(this.transport);
    console.log('✅ Connected to MCP Server');
  }

  private async initializeAssistantOnce() {
    if (process.env.ASSISTANT_ID) {
      try {
        const existing = await this.openai.beta.assistants.retrieve(process.env.ASSISTANT_ID);
        if (existing?.id) {
          this.assistantId = existing.id;
          console.log('✅ Loaded existing assistant:', this.assistantId);
          return;
        }
      } catch (e) {
        console.warn('⚠️ Existing assistant not found');
      }
    }
    throw new Error('ASSISTANT_ID must be set in environment variables');
  }

  // 🔄 Reset thread if it gets too long
  private async checkAndResetThread(sessionId: string): Promise<void> {
    const state = this.sessionState[sessionId];
    if (!state?.threadId || !state.messageCount) return;

    if (state.messageCount >= this.MAX_MESSAGES_PER_THREAD) {
      console.log(`🔄 Thread exceeded ${this.MAX_MESSAGES_PER_THREAD} messages. Creating new thread...`);
      
      // Create new thread
      const newThread = await this.openai.beta.threads.create();
      state.threadId = newThread.id;
      state.messageCount = 0;
      
      console.log(`✨ New thread created: ${newThread.id}`);
    }
  }

  async ensureThreadForSession(sessionId: string): Promise<string> {
    if (!this.sessionState[sessionId]) {
      this.sessionState[sessionId] = { messageCount: 0 };
    }

    if (!this.sessionState[sessionId].threadId) {
      if (!this.creatingThread[sessionId]) {
        this.creatingThread[sessionId] = this.openai.beta.threads.create()
          .then((thread: any) => {
            this.sessionState[sessionId].threadId = thread.id;
            this.sessionState[sessionId].messageCount = 0;
            delete this.creatingThread[sessionId];
            console.log(`✨ Created new thread: ${thread.id} for session ${sessionId}`);
            return thread.id;
          })
          .catch((err: any) => {
            delete this.creatingThread[sessionId];
            throw err;
          });
      }
      return this.creatingThread[sessionId];
    }

    return this.sessionState[sessionId].threadId!;
  }

  public async sendMessage(userMessage: string, sessionId = 'default'): Promise<{ reply: any }> {
    if (!this.mcpClient) await this.initMCP();
    if (!this.assistantId) await this.initializeAssistantOnce();
    if (!this.assistantId) throw new Error('Assistant not initialized.');

    // Check if thread needs reset
    await this.checkAndResetThread(sessionId);




    
    const threadId = await this.ensureThreadForSession(sessionId);
    if (!threadId) throw new Error('Failed to get threadId');

    console.log("📨 User message:", userMessage);
    




    // Add message to thread
    await this.openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: userMessage,
    });

    // Increment message count
    this.sessionState[sessionId].messageCount = (this.sessionState[sessionId].messageCount || 0) + 1;

    // Create run (don't poll yet)
    let run = await this.openai.beta.threads.runs.create(threadId, {
      assistant_id: this.assistantId,
    });

    // Manual polling with longer intervals
    run = await this.pollRunUntilComplete(threadId, run.id);

    if (run.status === 'failed') {
      console.error('❌ Run failed:', run.last_error?.message);
      return { 
        reply: { 
          role: 'assistant', 
          content: `I encountered an error: ${run.last_error?.message || 'Unknown error'}.` 
        } 
      };
    }

    // Handle tool calls if needed
    if (run?.required_action?.submit_tool_outputs?.tool_calls) {
      run = await this.handleToolCalls(threadId, run, sessionId);
    }

    // Log final token usage
    if (run?.usage) {
      console.log(`💰 TOTAL Tokens: ${run.usage.total_tokens} (prompt=${run.usage.prompt_tokens}, completion=${run.usage.completion_tokens})`);
    }

    // ✅ Fetch ONLY the latest message (limit: 1)
    const messages = await this.openai.beta.threads.messages.list(threadId, { 
      limit: 1,
      order: 'desc' 
    });
    
    const latestAssistant = messages.data[0];
    let assistantText = 'Sorry – could not generate response.';
    
    if (latestAssistant?.role === 'assistant' && latestAssistant?.content) {
      assistantText = latestAssistant.content
        .map((b: any) => b?.text?.value || '')
        .join('')
        .trim();
    }

    console.log("🤖 Assistant response:", assistantText);
    
    return { reply: { role: 'assistant', content: assistantText } };
  }

  // ✅ Custom polling with configurable intervals
  private async pollRunUntilComplete(threadId: string, runId: string): Promise<any> {
    let attempts = 0;
    let run = await this.openai.beta.threads.runs.retrieve(runId,{thread_id:threadId});

    while (
      attempts < this.MAX_POLL_ATTEMPTS &&
      !['completed', 'failed', 'expired', 'cancelled', 'requires_action'].includes(run.status)
    ) {
      await new Promise(r => setTimeout(r, this.POLL_INTERVAL_MS));
      run =  await this.openai.beta.threads.runs.retrieve(runId,{thread_id:threadId});
      attempts++;
      console.log(`  ⏳ Poll ${attempts}: ${run.status}`);
    }

    return run;
  }
  
  // ✅ Minimized tool outputs to reduce token usage
  private getMinimalToolOutput(toolName: string, rawResult: any): object | string {
    if (!rawResult || typeof rawResult !== 'object') {
      return rawResult; 
    }

    switch (toolName) {
      case 'getLocations':
        return {
          locations: rawResult.locations?.map((l: any) => ({
            id: l.id,
            name: l.name,
          })) || [],
        };

      case 'availableServices':
        // Handle the nested structure from your MCP server
        const categories = rawResult.cart?.availableCategories || [];
        const services = categories.flatMap((cat: any) => 
          (cat.availableItems || []).map((item: any) => ({
            id: item.id,
            name: item.name,
            price: item.listPrice,
          }))
        );
        return { services };

      case 'cartBookableDates':
        // Your MCP returns array directly, not wrapped
        return {
          dates: Array.isArray(rawResult) ? rawResult : (rawResult.dates || []),
        };

      case 'cartBookableTimes':
        // Your MCP returns slots directly
        return {
          times: (Array.isArray(rawResult) ? rawResult : []).slice(0, 15).map((t: any) => ({
            id: t.id,
            startTime: t.startTime,
          })),
        };
        
      case 'cartBookableStaffVariants':
        return {
          staff: rawResult.staffVariants?.map((s: any) => ({
            id: s.id,
            name: s.staff?.name,
            preference: s.staffSelectionPreference || 'None',
          })) || [],
        };
      
      case 'getCartSummary':
        // Handle your MCP structure (data is at root level after parsing)
        return {
          cartId: rawResult.id,
          totalAmount: rawResult.summary?.total,
          promotionCode: rawResult.promotionOffers?.[0]?.code,
          serviceItems: rawResult.selectedItems?.map((item: any) => ({
            serviceName: item.item?.name,
            staffName: item.selectedStaffVariant?.staff?.displayName,
            bookableTime: item.selectedBookableItem?.startTime,
          })) || [],
        };

      case 'createAppointmentCart':
        return { 
          cartId: rawResult.createCart?.cart?.id, 
          status: 'Cart Created' 
        };
          
      case 'addServiceToCart':
      case 'reserveCartBookableItems':
      case 'updateCartSelectedBookableItem':
        // These return the cart structure
        return { 
          status: 'Success', 
          cartId: rawResult.addCartSelectedBookableItem?.cart?.id || 
                  rawResult.reserveCartBookableItems?.cart?.id ||
                  rawResult.updateCartSelectedBookableItem?.cart?.id,
          message: `${toolName} completed.` 
        };
        
      case 'applyPromotionCode':
        return {
          status: 'Success',
          cartId: rawResult.addCartOffer?.cart?.id,
          promotionCode: rawResult.addCartOffer?.offer?.code,
          message: 'Promotion applied successfully'
        };
        
      case 'cartBookableStaffVariants':
        // Return minimal staff info
        return {
          staff: (Array.isArray(rawResult) ? rawResult : []).map((s: any) => ({
            id: s.id,
            name: s.staff?.displayName || s.staff?.firstName,
            price: s.price,
          })),
        };

      default:
        return { 
          status: 'Completed', 
          id: rawResult.id || rawResult.cartId,
          message: `${toolName} executed.`
        };
    }
  }

  private async executeMCPToolAndBuildPayload(toolCall: any, sessionId: string) {
    const tool_call_id = toolCall.id;
    const toolName = toolCall.function.name;
    let args: any = {};
    
    try {
      args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      args = {};
    }

    try {
      const rawResult = await this.mcpClient.callTool({ name: toolName, arguments: args });
      
      // Extract state from full result (for internal session tracking)
      try {
        this.extractStateFromToolOutput(rawResult, sessionId);
      } catch { /* ignore */ }
      
      // ✅ PARSE the MCP response properly
      let parsedResult = rawResult;
      if (rawResult?.content?.[0]?.text) {
        try {
          parsedResult = JSON.parse(rawResult.content[0].text);
        } catch {
          parsedResult = rawResult.content[0].text;
        }
      }
      
      // ✅ CRITICAL FIX: Use minimized output for LLM
      const minimalResult = this.getMinimalToolOutput(toolName, parsedResult);
      const outputString = JSON.stringify(minimalResult);
      
      console.log(`🛠️  ${toolName} output size: ${outputString.length} chars (minimized)`);
          
      return {
        tool_call_id,
        output: outputString,
      };
    } catch (err: any) {
      const errObj = { error: true, message: err?.message || String(err) };
      return { tool_call_id, output: JSON.stringify(errObj) };
    }
  }

  private async handleToolCalls(
    threadId: string, 
    initialRun: any, 
    sessionId: string
  ): Promise<any> {
    let currentRun: any = initialRun;
    let iterationCount = 0;
    const maxIterations = 10;
    
    console.log(`🔧 Tool handler - Thread: ${threadId}`);
    
    while (
      currentRun.required_action?.type === 'submit_tool_outputs' && 
      iterationCount < maxIterations
    ) {
      iterationCount++;
      console.log(`🔧 Iteration ${iterationCount}`);
      
      const toolCalls = currentRun.required_action.submit_tool_outputs.tool_calls;
      const toolOutputs: any[] = [];
      
      for (const toolCall of toolCalls) {
        console.log(`  🛠️  Executing: ${toolCall.function.name}`);
        const output = await this.executeMCPToolAndBuildPayload(toolCall, sessionId);
        toolOutputs.push(output);
      }
      
      console.log(`📤 Submitting ${toolOutputs.length} tool outputs`);
      
      try {
       
        const updatedRun = await this.openai.beta.threads.runs.submitToolOutputs(
          currentRun.id,                 // run ID
          {
            thread_id: threadId, // REQUIRED: thread ID goes here
            tool_outputs: toolOutputs // your tool outputs array
          }
        )
        
        // Poll with longer intervals
        currentRun = await this.pollRunUntilComplete(threadId, updatedRun.id);
        
        console.log(`✅ Status after submission: ${currentRun.status}`);
        
      } catch (error: any) {
        console.error('❌ Error submitting tool outputs:', error.message);
        throw error;
      }
      
      if (['completed', 'failed', 'expired', 'cancelled'].includes(currentRun.status)) {
        break;
      }
    }
    
    console.log(`🏁 Tool loop complete: ${currentRun.status}`);
    return currentRun;
  }

  private extractStateFromToolOutput(toolOutput: any, sessionId = 'default') {
    if (!toolOutput || typeof toolOutput !== 'object') return;
    if (!this.sessionState[sessionId]) this.sessionState[sessionId] = {};
    const s = this.sessionState[sessionId];

    const preservedThreadId = s.threadId;
    const preservedMessageCount = s.messageCount;

    const setIf = (k: keyof SessionState, v: any) => {
      if (k === 'threadId' || k === 'messageCount') return;
      if (v !== undefined && v !== null) (s as any)[k] = v;
    };

    if (typeof toolOutput.createCart?.cart?.id === 'string') setIf('cartId', toolOutput.createCart.cart.id);
    if (typeof toolOutput.cartId === 'string') setIf('cartId', toolOutput.cartId);
    if (Array.isArray(toolOutput.offers) && toolOutput.offers[0]?.id) setIf('promotionOfferId', toolOutput.offers[0].id);
    if (toolOutput.addCartOffer?.offer?.id) setIf('promotionOfferId', toolOutput.addCartOffer.offer.id);

    try {
      const selectedItems = toolOutput.selectedItems || toolOutput.cart?.selectedItems || toolOutput.data?.cart?.selectedItems;
      if (Array.isArray(selectedItems) && selectedItems.length > 0) {
        const top = selectedItems[0];
        if (typeof top.id === 'string') setIf('serviceItemId', top.id);
        if (typeof top.staffVariantId === 'string') setIf('staffVariantId', top.staffVariantId);
      }
    } catch {}

    try {
      const bookable = toolOutput.selectedBookableItem || toolOutput.cart?.selectedBookableItem || toolOutput.selected_bookable_item;
      if (bookable?.id) setIf('bookableTimeId', bookable.id);
    } catch {}

    try {
      const email = toolOutput.updateCart?.cart?.clientInformation?.email || toolOutput.cart?.clientInformation?.email || toolOutput.client?.email;
      if (email) setIf('clientEmail', email);
      const total = toolOutput.getCartSummary?.cart?.summary?.total ?? toolOutput.cart?.summary?.total ?? toolOutput.cart?.total;
      if (typeof total === 'number') setIf('totalAmount', total / 100);
    } catch {}

    if (preservedThreadId) s.threadId = preservedThreadId;
    if (preservedMessageCount !== undefined) s.messageCount = preservedMessageCount;
  }

  public async setPaymentToken(token: string, sessionId = 'default') {
    const s = this.sessionState[sessionId];
    if (!s?.cartId) throw new Error('Cart not available');
    
    await this.mcpClient.callTool({ 
      name: 'addCartCardPaymentMethod', 
      arguments: { cartId: s.cartId, token, select: true } 
    });
    
    const checkoutResult: any = await this.mcpClient.callTool({ 
      name: 'checkoutCart', 
      arguments: { cartId: s.cartId } 
    });
    
    return checkoutResult;
  }

  public clearSession(sessionId = 'default') {
    delete this.sessionState[sessionId];
    delete this.creatingThread[sessionId];
  }

  async onModuleInit() {
    await this.initMCP();
    await this.initializeAssistantOnce();
    
    console.log('🔍 OpenAI SDK initialized:', {
      hasBeta: !!this.openai?.beta,
      threadsRuns: !!this.openai?.beta?.threads?.runs,
    });
  }
}