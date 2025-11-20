// src/chat/chat.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import OpenAI from 'openai';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { log } from 'node:console';

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

  private conversationHistory:any;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }





  private async initMCP(module:any) {
    this.transport = new StdioClientTransport({
      command: 'node',
     // args: ['dist/appointment-booking.js','dist/giftcard-purchase.js'],
     args: module=='gift'?['dist/giftcard-purchase.js']:['dist/appointment-booking.js'],
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

  private detectAssistant(userMessage: string, currentIntent:any){
    const lower = userMessage.toLowerCase();

  
    if (lower.includes('membership') || lower.includes('member') || lower.includes('package') || lower.includes('plan')) {
      this.conversationHistory = "membership";
      return 'membership';
    }
    if (lower.includes('book') || lower.includes('appointment') || lower.includes('service') || lower.includes('schedule')) {
      this.conversationHistory = "booking";
      return 'booking';
    }
    if (lower.includes('gift') || lower.includes('giftcard')) {
      this.conversationHistory = "gift";
      return 'gift';
    }
  
    // default to booking if unsure
    return null;

    // const bookingKeywords = [
    //   'book', 'appointment', 'service'
    // ];

    // const giftKeywords = [
    //   'gift card', 'giftcard', 'buy gift', 'purchase gift', 'gift amount',
    //   'send gift', 'email gift card', 'gift'
    // ];
  
    // if (bookingKeywords.some(k => msg.includes(k))) {
    //   return 'booking';
    // }

    // if (giftKeywords.some(k => msg.includes(k))) {
    //   return 'gift';
    // }
  
    // return null;
  }
  

  public async sendMessage(
    userMessage: string,
    sessionId = "default"
  ): Promise<{ reply: any }> {
  
    let intent: any = "";
    intent = this.detectAssistant(userMessage, this.conversationHistory);
  
    if (!this.mcpClient) await this.initMCP(this.conversationHistory);
  
    if (this.conversationHistory === "gift") {
      this.assistantId = process.env.GIFT_ASSISTANT_ID!;
    } else {
      this.assistantId = process.env.BOOKING_ASSISTANT_ID!;
    }
  
    await this.checkAndResetThread(sessionId);
  
    const threadId = await this.ensureThreadForSession(sessionId);
    if (!threadId) {
      return {
        reply: {
          role: "assistant",
          content: "Sorry, I couldn't create a conversation thread."
        }
      };
    }
  
    console.log("📨 User message:", userMessage);
  
    await this.openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: userMessage,
    });
  
    this.sessionState[sessionId].messageCount =
      (this.sessionState[sessionId].messageCount || 0) + 1;
  
    let run = await this.openai.beta.threads.runs.create(threadId, {
      assistant_id: this.assistantId,
    });
  
    run = await this.pollRunUntilComplete(threadId, run.id);
  
    if (run.status === "failed") {
      return {
        reply: {
          role: "assistant",
          content: `I encountered an error: ${run.last_error?.message || "Unknown error"}`
        }
      };
    }
  
    // ---------------------------------------------------------
    // 🔥 Tool calls handling (may return final formatted reply)
    // ---------------------------------------------------------
    if (run?.required_action?.submit_tool_outputs?.tool_calls) {
      const toolResponse = await this.handleToolCalls(threadId, run, sessionId);
  
      // If handleToolCalls returned a FINAL chatbot reply (Format A or B)
      if (toolResponse?.reply) {
        return toolResponse; // <-- IMPORTANT
      }
  
      // Otherwise, continue using updated run
      run = toolResponse;
    }
  
    // ---------------------------------------------------------
    // After all tools: fetch assistant's latest message
    // ---------------------------------------------------------
    const messages = await this.openai.beta.threads.messages.list(threadId, {
      limit: 1,
      order: "desc",
    });
  
    const latest = messages?.data?.[0];
    let assistantText = "Sorry – could not generate a response.";
  
    if (latest?.role === "assistant" && latest?.content) {
      assistantText = latest.content
        .map((b: any) => b?.text?.value || "")
        .join("")
        .trim();
    }
  
    console.log("🤖 Assistant response:", assistantText);
  
    // ---------------------------------------------------------
    // Optional frontend-action extraction
    // ---------------------------------------------------------
    const frontendAction = this.extractFrontendAction(assistantText);
  
    if (frontendAction) {
      return {
        reply: {
          role: "assistant",
          frontendAction,
          content: assistantText
        }
      };
    }
  
    // ---------------------------------------------------------
    // Format-A: Normal reply
    // ---------------------------------------------------------
    return {
      reply: {
        role: "assistant",
        content: assistantText
      }
    };
  }
  
  
  
  // ----------------------------------------------
  // Optional: Extract frontend action metadata
  // ----------------------------------------------
  private extractFrontendAction(text: string): any {
    // Example: assistant prints some tag like <PAY_BUTTON> or similar logic
    if (text.includes("[[SHOW_PAY_BUTTON]]")) {
      return {
        type: "SHOW_PAY_BUTTON",
        checkoutUrl: `https://blvd-chatbot.ostlive.com/checkout?email=${this.sessionState.clientEmail}&amount=${this.sessionState.totalAmount}`
      };
    }
  
    return null;
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
      
      console.log("rawresult",rawResult);
      

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
      console.log("toolCalls >> ", toolCalls);
  
      const toolOutputs: any[] = [];
  
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        console.log(`  🛠️ Executing: ${toolName}`);
  
// ---------------------------------------------------------
// ✅ UNIVERSAL CART-ID FIX
// ---------------------------------------------------------
if (toolCall.function?.arguments) {
  try {
    let args = JSON.parse(toolCall.function.arguments);
    const correctCartId = this.sessionState[sessionId]?.cartId;

    if (correctCartId) {
      // Many BLVD tools use "cartId"
      if (args.cartId && args.cartId !== correctCartId) {
        console.log("🔧 Fixing cartId → session cartId:", correctCartId);
        args.cartId = correctCartId;
      }

      // Some tools (like addGiftCardToCart) use "id"
      if (args.id && args.id.startsWith("urn:blvd:Cart:") && args.id !== correctCartId) {
        console.log("🔧 Fixing id → session cartId:", correctCartId);
        args.id = correctCartId;
      }
    }

    toolCall.function.arguments = JSON.stringify(args);
  } catch (err) {
    console.error("❌ Failed parsing tool arguments:", err);
  }
}

        // --------------------------------------------------------
        // 🎁 SPECIAL CASE — setClientOnCart
        // --------------------------------------------------------
        if (toolName === "setClientOnCart") {
          const result: any = await this.executeMCPToolAndBuildPayload(toolCall, sessionId);
        
          // ✅ Parse correct payload for state extraction
          let parsedOutput = {};
          try {
            parsedOutput = JSON.parse(result.output);
          } catch {}
        
          // ✅ Extract cartId / email into session state
          this.extractStateFromToolOutput(parsedOutput, sessionId);
        
          const s = this.sessionState[sessionId];
        
          return {
            reply: {
              role: "assistant",
              frontendAction: {
                type: "SHOW_PAY_BUTTON",
                checkoutUrl: `https://blvd-chatbot.ostlive.com/checkout?email=${s.clientEmail}&amount=${s.totalAmount}`
              },
              content: "You're all set! Tap the button below to complete your payment."
            }
          };
        }
        
        
  
        // --------------------------------------------------------
        // 🔧 NORMAL TOOLS
        // --------------------------------------------------------
        const output = await this.executeMCPToolAndBuildPayload(toolCall, sessionId);
        toolOutputs.push(output);
      }
  
      // --------------------------------------------------------
      // If no early-return happened above, submit outputs normally
      // --------------------------------------------------------
      console.log(`📤 Submitting ${toolOutputs.length} tool outputs`);
  
      try {
        const updatedRun = await this.openai.beta.threads.runs.submitToolOutputs(
          currentRun.id,
          {
            thread_id: threadId,
            tool_outputs: toolOutputs
          }
        );
  
        // Poll again until the next stage
        currentRun = await this.pollRunUntilComplete(threadId, updatedRun.id);
  
        // console.log(`✅ Status after submission: ${currentRun.status}`);
  
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
    // console.log("🟦 extractStateFromToolOutput() CALLED ------------------------");
    // console.log("🔵 Raw toolOutput:", JSON.stringify(toolOutput, null, 2));
  
     // 🔥 STEP 1 — UNWRAP content[] text JSON
  if (Array.isArray(toolOutput?.content) && toolOutput.content[0]?.text) {
    try {
      const parsed = JSON.parse(toolOutput.content[0].text);
      console.log("🟢 Parsed inner JSON:", parsed);
      toolOutput = parsed; // Replace wrapper with actual object
    } catch (err) {
      console.log("❌ Failed to parse content[0].text:", err);
    }
  }

  if (!toolOutput || typeof toolOutput !== 'object') {
    console.log("❌ toolOutput is empty or invalid");
    return;
  }
  
    if (!this.sessionState[sessionId]) this.sessionState[sessionId] = {};
    const s = this.sessionState[sessionId];
  
    // console.log("🟡 Previous session state:", JSON.stringify(s, null, 2));
  
    const preservedThreadId = s.threadId;
    const preservedMessageCount = s.messageCount;
  
    const setIf = (k: keyof SessionState, v: any) => {
      if (k === 'threadId' || k === 'messageCount') {
        // console.log(`⏭️ SKIP updating reserved key ${k}`);
        return;
      }
      if (v !== undefined && v !== null) {
        // console.log(`🟢 Setting s.${k} =`, v);
        (s as any)[k] = v;
      } else {
        // console.log(`⚪ Value for ${k} was undefined/null, ignored`);
      }
    };
  
    // ----------------------- CART ID -----------------------
    // console.log("🔍 Checking for cartId sources...");
  
    if (typeof toolOutput.createCart?.cart?.id === 'string') {
      console.log("🟢 cartId from createCart:", toolOutput.createCart.cart.id);
      setIf('cartId', toolOutput.createCart.cart.id);
    }
  
    if (typeof toolOutput.updateCart?.cart?.id === 'string') {
      console.log("🟢 cartId from updateCart:", toolOutput.updateCart.cart.id);
      setIf('cartId', toolOutput.updateCart.cart.id);
    }
  
    if (typeof toolOutput.cartId === 'string') {
      console.log("🟢 cartId from direct.cartId:", toolOutput.cartId);
      setIf('cartId', toolOutput.cartId);
    }
  
    // ----------------------- PROMOTION -----------------------
    if (Array.isArray(toolOutput.offers) && toolOutput.offers[0]?.id) {
      console.log("🟢 promotionOfferId from offers:", toolOutput.offers[0].id);
      setIf('promotionOfferId', toolOutput.offers[0].id);
    }
  
    if (toolOutput.addCartOffer?.offer?.id) {
      console.log("🟢 promotionOfferId from addCartOffer:", toolOutput.addCartOffer.offer.id);
      setIf('promotionOfferId', toolOutput.addCartOffer.offer.id);
    }
  
    // ----------------------- SELECTED ITEMS -----------------------
    try {
      const selectedItems =
        toolOutput.selectedItems ||
        toolOutput.cart?.selectedItems ||
        toolOutput.data?.cart?.selectedItems;
  
      if (Array.isArray(selectedItems) && selectedItems.length > 0) {
        const top = selectedItems[0];
        console.log("🟢 selectedItems found:", top);
  
        if (typeof top.id === 'string') setIf('serviceItemId', top.id);
        if (typeof top.staffVariantId === 'string') setIf('staffVariantId', top.staffVariantId);
      } else {
        console.log("⚪ No selectedItems found");
      }
    } catch (err) {
      console.log("❌ Error processing selectedItems", err);
    }
  
    // ----------------------- BOOKABLE TIME -----------------------
    try {
      const bookable =
        toolOutput.selectedBookableItem ||
        toolOutput.cart?.selectedBookableItem ||
        toolOutput.selected_bookable_item;
  
      if (bookable?.id) {
        console.log("🟢 bookableTimeId:", bookable.id);
        setIf('bookableTimeId', bookable.id);
      } else {
        console.log("⚪ No selectedBookableItem found");
      }
    } catch (err) {
      console.log("❌ Error processing bookableTimeId", err);
    }
  
    // ----------------------- EMAIL + TOTAL AMOUNT -----------------------
    try {
      const email =
        toolOutput.updateCart?.cart?.clientInformation?.email ||
        toolOutput.cart?.clientInformation?.email ||
        toolOutput.client?.email;
  
      if (email) {
        console.log("🟢 clientEmail:", email);
        setIf('clientEmail', email);
      }
  
      const total =
        toolOutput.getCartSummary?.cart?.summary?.total ??
        toolOutput.cart?.summary?.total ??
        toolOutput.cart?.total;
  
      if (typeof total === 'number') {
        console.log("🟢 totalAmount (converted):", total / 100);
        setIf('totalAmount', total / 100);
      }
    } catch (err) {
      console.log("❌ Error processing email/total", err);
    }
  
    // ----------------------- PRESERVE THREAD + COUNT -----------------------
    if (preservedThreadId) {
      console.log("🔒 Preserving original threadId:", preservedThreadId);
      s.threadId = preservedThreadId;
    }
  
    if (preservedMessageCount !== undefined) {
      console.log("🔒 Preserving original messageCount:", preservedMessageCount);
      s.messageCount = preservedMessageCount;
    }
  
    console.log("🟢 Updated session state:", JSON.stringify(s, null, 2));
    console.log("🟩 extractStateFromToolOutput() END ------------------------");
  }
  
  public async setPaymentToken(token: string, sessionId = 'default') {
    const s = this.sessionState[sessionId];
    
    console.log("sssss",s);
    
    if (!s?.cartId) throw new Error('Cart not available');
    
    const res=await this.mcpClient.callTool({ 
      name: 'addCartCardPaymentMethod', 
      arguments: { cartId: s.cartId, token, select: true } 
    });

    
    
    const checkoutResult: any = await this.mcpClient.callTool({ 
      name: 'checkoutCart', 
      arguments: { cartId: s.cartId } 
    });

    console.log("att",checkoutResult.content[0].text);
    // console.log("tes",JSON.parse(checkoutResult.content[0].text?.checkoutCart?.summary));


    
    
    return checkoutResult;
  }

  public clearSession(sessionId = 'default') {
    delete this.sessionState[sessionId];
    delete this.creatingThread[sessionId];
  }

  async onModuleInit() {
   // await this.initMCP();
    // await this.initializeAssistantOnce();

    if (!process.env.BOOKING_ASSISTANT_ID)
      throw new Error("BOOKING_ASSISTANT_ID missing");
  
    if (!process.env.GIFT_ASSISTANT_ID)
      throw new Error("GIFT_ASSISTANT_ID missing");
  
    console.log("✅ Assistants ready");
    
    console.log('🔍 OpenAI SDK initialized:', {
      hasBeta: !!this.openai?.beta,
      threadsRuns: !!this.openai?.beta?.threads?.runs,
    });
  }
}