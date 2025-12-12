// src/chat/chat.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import OpenAI from 'openai';
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { log } from 'node:console';
import Redis from 'ioredis';


interface UserContext { 
  threadId?: string; 
  cartId?: string;
  serviceItemId?: string;
  bookableTimeId?: string; 
  staffVariantId?: string;
  promotionOfferId?: string; 
  clientEmail?: string; 
  totalAmount?: number; 
  awaitingClientDetails?: boolean; 
  messageCount?: number; 
  sessionToken?: any; 
  assistantType?: "booking" | "giftcard" | "membership"; 
  clientInfo?: { email?: string; phone?: string; name?: string; }; 
  appointmentHistory?: { appointmentId: string; createdAt: string; serviceName?: string; }[]; 
  
  booking?: { cartId?: string; serviceItemId?: string; bookableTimeId?: string; staffVariantId?: string; promotionOfferId?: string; addonServices?: { id: string; name: string }[]; clientInfo?: { email?: string; phone?: string; name?: string; }; checkoutAppointments?: string[]; };
  membership?: { membershipPlanId?: string; membershipCartId?: string; clientInfo?: { email?: string; phone?: string; name?: string; }; }; 
  giftcard?: { amount?: number; clientInfo?: { email?: string; phone?: string; name?: string; }; giftcardCartId?: string; recipientEmail?: string; senderMessage?: string; }; flags?: { awaitingClientDetails?: boolean; }; }

@Injectable()
export class ChatService implements OnModuleInit {
  private openai: any;
  private mcpClient!: MCPClient;
  private transport!: any;


    // In-memory L1 cache for contexts to avoid too many redis calls (optional)
    private contextCache: Map<string, UserContext> = new Map();

    // Redis client (source of truth)
    private redis: any;

    
  private assistantId: string | null = null;
  // private sessionState: Record<string, SessionState> = {};
  private creatingThread: Record<string, Promise<string>> = {};
  private lastUserMessage: string = "";

  // ⚙️ Configuration
  private readonly MAX_MESSAGES_PER_THREAD = 15; // Reset thread after 20 messages
  private readonly POLL_INTERVAL_MS = 2000; // Slower polling = fewer API calls
  private readonly MAX_POLL_ATTEMPTS = 30;

  private conversationHistory:any;

  lastResolvedRangeLower:any;
  lastResolvedRangeUpper:any; 
  lastResolvedDate:any;



  private sessionToken:any;

  private moduleMap: Record<string, string> = {
    gift: 'dist/giftcard-purchase.js',
    membership: 'dist/membership-booking.js',
    booking: 'dist/appointment-booking.js',
  };

  private moduleName:any;

  constructor() {
    //console.log("sessionToken in chat.service.ts",this.sessionToken);
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    this.redis = new (Redis as any)(redisUrl);


  }

  private ctxKey(uuid: string) {
    return `chat:ctx:${uuid}`;
  }

  private async loadUserContext(uuid: string): Promise<UserContext> {
    // Try cache first
    if (this.contextCache.has(uuid)) {
      return this.contextCache.get(uuid)!;
    }

    const raw = await this.redis.get(this.ctxKey(uuid));
    const parsed: UserContext = raw ? JSON.parse(raw) : {};
    
    console.log("parsed", parsed);
    console.log("raw", raw);
    console.log("uuid", uuid);
    console.log("ctxKey", this.ctxKey(uuid));
    console.log("redis", this.redis);
    // populate cache
    this.contextCache.set(uuid, parsed);
    return parsed;
  }

  private async saveUserContext(uuid: string, ctx: UserContext): Promise<void> {
    // Update cache and redis
    this.contextCache.set(uuid, ctx);
    await this.redis.set(this.ctxKey(uuid), JSON.stringify(ctx));
  }

  private async clearUserContextFields(uuid: string, fields: (keyof UserContext)[]) {
    const ctx = await this.loadUserContext(uuid);
    for (const f of fields) {
      delete (ctx as any)[f];
    }
    await this.saveUserContext(uuid, ctx);
  }




  tokenGenerate(uuid:string){
    let token = Math.random().toString(36).substring(2, 10);
    this.loadUserContext(uuid).then(ctx => {
      ctx.sessionToken = token;
      this.saveUserContext(uuid, ctx).catch(() => {});
    }).catch(() => {});
    console.log("token in chat.service.ts", token);
    return token;
  }

  private async initMCP(module:any) {

    this.moduleName = module;
    const moduleFile = this.moduleMap[module] ?? 'dist/appointment-booking.js';

    this.transport = new StdioClientTransport({
      command: 'node',
     // args: ['dist/appointment-booking.js','dist/giftcard-purchase.js'],
     args: [moduleFile],
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
  private async checkAndResetThread(uuid: string): Promise<void> {
    const ctx = await this.loadUserContext(uuid);
    if (!ctx?.threadId || !ctx.messageCount) return;

    if (ctx.messageCount >= this.MAX_MESSAGES_PER_THREAD) {
      console.log(`🔄 Thread exceeded ${this.MAX_MESSAGES_PER_THREAD} messages. Creating new thread...`);

      const newThread = await this.openai.beta.threads.create();
      ctx.threadId = newThread.id;
      ctx.messageCount = 0;

      await this.saveUserContext(uuid, ctx);
      console.log(`✨ New thread created: ${newThread.id}`);
    }
  }
  async ensureThreadForUser(uuid: string): Promise<string> {
    const ctx = await this.loadUserContext(uuid);

    if (!ctx.threadId) {
      if (!this.creatingThread[uuid]) {
        this.creatingThread[uuid] = this.openai.beta.threads.create()
          .then((thread: any) => {
            ctx.threadId = thread.id;
            ctx.messageCount = 0;
            // persist
            return this.saveUserContext(uuid, ctx).then(() => {
              this.conversationHistory = null;
              delete this.creatingThread[uuid];
              console.log(`✨ Created new thread: ${thread.id} for user ${uuid}`);
              return thread.id;
            });
          })
          .catch((err: any) => {
            delete this.creatingThread[uuid];
            throw err;
          });
      }
      return this.creatingThread[uuid];
    }
    return ctx.threadId!;
  }



 private detectAssistant(userMessage: string, uuid: string) {
    const lower = userMessage.toLowerCase();

    // load context only if we need to update it
    // but we also want to set assistantType into context
    const setAssistant = async (type: string) => {
      const ctx :any= await this.loadUserContext(uuid);
      ctx.assistantType = type;
      ctx.sessionToken = ctx.sessionToken ?? this.tokenGenerate(uuid);
      await this.saveUserContext(uuid, ctx);
    };

    if (lower.includes('membership') || lower.includes('member') || lower.includes('package') || lower.includes('plan')) {
      this.conversationHistory = "membership";
      setAssistant('membership').catch(() => {});
      return 'membership';
    }

    if (lower.includes('gift') || lower.includes('giftcard')) {
      this.conversationHistory = "gift";
      setAssistant('gift').catch(() => {});
      return 'gift';
    }

    if (lower.includes('book') || lower.includes('appointment') || lower.includes('service') || lower.includes('schedule')) {
      this.conversationHistory = "booking";
      setAssistant('booking').catch(() => {});
      return 'booking';
    }

    return null;
  }
  

  public async sendMessage(
    userMessage: string,
    sessionId: string, // keep ephemeral session id if your frontend sends it
    uuid: string // persistent user id from frontend
  ): Promise<{ reply: any }> {

    let intent: any = "";

    // ensure a thread for the user
    const threadId = await this.ensureThreadForUser(uuid);

    intent = this.detectAssistant(userMessage, uuid);

    console.log("intent", intent);

    // init MCP if needed
    if (!this.mcpClient || this.moduleName !== this.conversationHistory) {
      await this.initMCP(this.conversationHistory);
    }

    if (intent) {
      this.conversationHistory = intent;
    }

    console.log("intentintent  >> ", intent);
    console.log("conversationHistory >> ", this.conversationHistory)

    if (!this.conversationHistory) {
      // New session → always use Booking assistant for default greeting
      this.assistantId = process.env.DEFAULT_ASSISTANT_ID!;
    } else if (this.conversationHistory === 'gift') {
      this.assistantId = process.env.GIFT_ASSISTANT_ID!;
      console.log("🎁 Using Gift Card Assistant");
    } else if (this.conversationHistory === 'membership') {
      this.assistantId = process.env.MEMBERSHIP_ASSISTANT_ID!;
    } else {
      this.assistantId = process.env.BOOKING_ASSISTANT_ID!;
      console.log("💇 Using Booking Assistant");
    }

    console.log("assistantId", this.assistantId);

    await this.checkAndResetThread(uuid);

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

    // increment message count on context
    const ctx = await this.loadUserContext(uuid);
    ctx.messageCount = (ctx.messageCount || 0) + 1;
    await this.saveUserContext(uuid, ctx);

    let run = await this.openai.beta.threads.runs.create(threadId, {
      assistant_id: this.assistantId,
      additional_instructions: `
      Here is the user's persistent context:
      ${JSON.stringify(ctx, null, 2)}
      
      Rules:
      - If user asks about cart, service, addons, email, or booking info, answer using this context.
      - If context value exists, NEVER say "I don't know".
      - Only say unknown if the field is not present in context.
      
      CLIENT INFORMATION WORKFLOW:
      - When you need to collect client information for booking, check the context first.
      - If client info exists in context (email, name, phone), present it to the user like this:
        "I have your information on file:
        - Email: [email from context]
        - Name: [first name] [last name from context]
        - Phone: [phone from context]
        
        Would you like to use this information? (Reply 'yes' to confirm or provide new details)"
      
      - If user confirms with "yes", "correct", "that's right", or similar affirmative response, immediately call setClientOnCart with the stored information.
      - If user provides new information, use the new information and call setClientOnCart.
      - If no client info exists in context, ask the user to provide their email, name, and phone number.
      - NEVER ask for information that's already confirmed - proceed directly to setClientOnCart.
      
      IMPORTANT: When calling setClientOnCart, use these exact field names:
      - email (from context or user input)
      - firstName (from context or user input)
      - lastName (from context or user input)
      - phoneNumber (from context or user input)
        `
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

    this.lastUserMessage = userMessage;

    // ---------------------------------------------------------
    // 🔥 Tool calls handling (may return final formatted reply)
    // ---------------------------------------------------------
    if (run?.required_action?.submit_tool_outputs?.tool_calls) {
      const toolResponse = await this.handleToolCalls(threadId, run, uuid);

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
    const frontendAction = this.extractFrontendAction(assistantText, uuid);

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

  private extractFrontendAction(text: string, uuid: string): any {
    // Example: assistant prints some tag like <PAY_BUTTON> or similar logic
    if (text.includes("[[SHOW_PAY_BUTTON]]")) {
      // we load context to build checkout link
      const ctxPromise = this.loadUserContext(uuid);
      // build the result asynchronously; but this function is sync in original code so:
      // we'll return a minimal object and the sendMessage workflow already uses it synchronously.
      // To keep things simple here, fetch synchronously via cached context (loadUserContext caches)
      const ctx = this.contextCache.get(uuid) ?? {};
      return {
        type: "SHOW_PAY_BUTTON",
        checkoutUrl: `${process.env.CHECKOUT_LINK}/?email=${ctx.clientEmail || ''}&amount=${ctx.totalAmount || 0}&token=${ctx.sessionToken || ''}`
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
  private getMinimalToolOutput(toolName: string, rawResult: any, uuid: string): object | string {
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

      // case 'availableServices':
      //   // Handle the nested structure from your MCP server
      //   const categories = rawResult.cart?.availableCategories || [];
      //   const services = categories.flatMap((cat: any) => 
      //     (cat.availableItems || []).map((item: any) => ({
      //       id: item.id,
      //       name: item.name,
      //       price: item.listPrice,
      //     }))
      //   );
      //   return { services };

      case 'availableServices':
        // Handle the nested structure from your MCP server
        const categories = rawResult || [];

        const services = categories.flatMap((cat: any) => 
          (cat.availableItems || []).map((item: any) => ({
            categoryName: cat.name,
            items: (cat.availableItems || []).map(item => ({
              id: item.id,
              name: item.name,
              price: item.listPrice
            }))
          }))
        );

        console.log("servicesservices  >> ",services);

        return { services };


        case 'resolveDateRange': {
          // rawResult = string or object depending on your parser
          let parsed;
        
          // If rawResult is a JSON string, parse it
          if (typeof rawResult === "string") {
            try {
              parsed = JSON.parse(rawResult);
            } catch {
              parsed = {};
            }
          } else {
            parsed = rawResult || {};
          }
        
          return {
            dates: {
              resolvedDate: parsed.resolvedDate,
              rangeLower: parsed.rangeLower,
              rangeUpper: parsed.rangeUpper,
            },
          };
        }  

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
        
        // case 'cartBookableStaffVariants':
        //   return {
        //     staff: rawResult?.map((s: any) => ({
        //       id: s.id,
        //       name: s.staff?.name,
        //       preference: s.staffSelectionPreference || 'None',
        //     })) || [],
        //   };
  
      
      case 'getCartSummary':
        // Handle your MCP structure (data is at root level after parsing)
        return {
          cartId: rawResult.id,
          subotalAmount: rawResult.summary?.subtotal,
          promotionCode: rawResult.promotionOffers?.[0]?.code,
          discountAmount: rawResult.summary?.discountAmount,
          taxAmount: rawResult.summary?.taxAmount,
          totalAmount: rawResult.summary?.total,
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
          
        case "addServiceToCart": {
          const cart = rawResult.addCartSelectedBookableItem?.cart;
          const selectedItems = cart?.selectedItems || [];
  
          const addonServices: { id: string; name: string }[] = [];
  
          selectedItems.forEach((item: any) => {
            const optionGroups = item.item?.optionGroups || [];
            if (optionGroups.length > 0 && optionGroups[0].name?.toLowerCase() === "addon") {
              addonServices.push({
                id: item.id,
                name: item?.item?.name || item?.name
              });
            }
          });
  
          // persist addonServices into user context
          this.loadUserContext('temp').catch(()=>{}); // no-op; we will set when available
          // Note: the caller of this function passes uuid and will separately save addonServices in extractStateFromToolOutput
  
          const addons = selectedItems.flatMap((item: any) =>
            item.addons?.map((addon: any) => ({
              id: addon.id,
              name: addon.name,
              description: addon.description,
              price: addon.listPrice,
            })) || []
          );
  
          return {
            status: "Success",
            cartId: cart?.id,
            message: "Service added to cart.",
            addons
          };
        }

   
        
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
        
        case 'applyPromotionCode': {

            console.log("🟡 DEBUG → rawResult for applyPromotionCode:", JSON.stringify(rawResult, null, 2));
        
            // HANDLE ARRAY ERROR OUTPUT
            if (
                Array.isArray(rawResult) &&
                rawResult[0]?.__typename === "BlvdError"
            ) {
                return {
                    status: "Error",
                    code: rawResult[0]?.code,
                    message: rawResult[0]?.message || "Invalid promotion code"
                };
            }
        
            // HANDLE NORMAL ERROR FORMAT
            if (rawResult?.errors || rawResult?.error || rawResult?.code) {
                console.log("i enter");
                return {
                    status: "Error",
                    code: rawResult?.code,
                    message: rawResult?.message || "Invalid promotion code"
                };
            }
        
            // SUCCESS CASE
            return {
                status: "Success",
                cartId: rawResult.addCartOffer?.cart?.id,
                promotionCode: rawResult.addCartOffer?.offer?.code,
                message: "Promotion applied successfully"
            };
        }
        
        
      case 'cartBookableStaffVariants':
        // Return minimal staff info
        return {
          staff: (Array.isArray(rawResult) ? rawResult : []).map((s: any) => ({
            id: s.id,
            name: s.staff?.displayName || s.staff?.firstName,
            price: s.price,
          })),
        };


        /* for membership start */
      case 'getMembershipPlans':
        return {
          membership: (Array.isArray(rawResult) ? rawResult : []).map((item: any) => ({
            id: item.node.id,
            name: item.node.name,
            price: item.node.unitPrice,
          })),
        };

        case 'addMemberhipToCart':
          return {
            membership: (Array.isArray(rawResult) ? rawResult : []).map((item: any) => ({
              id: item.node.id,
              name: item.node.name,
              price: item.node.unitPrice,
            })),
          };

      /*membership end*/


      // /*********** giftcard start ***********/
      // case 'createGiftCardCart':
      //   console.log("createGiftCardCart rrrrrr >> ",rawResult);
      //     return {
      //       giftcard: (Array.isArray(rawResult) ? rawResult : []).map((item: any) => ({
      //         cartId: rawResult.createCart?.cart?.id,
      //       })),
      //     };

      // /*********** giftcard end ***********/

      default:
        return { 
          status: 'Completed', 
          id: rawResult.id || rawResult.cartId,
          message: `${toolName} executed.`
        };
    }
  }

  private async executeMCPToolAndBuildPayload(toolCall: any, uuid: string) {
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
        await this.extractStateFromToolOutput(rawResult, uuid);
      } catch { /* ignore */ }

      let parsedResult = rawResult;
      if (rawResult?.content?.[0]?.text) {
        try {
          parsedResult = JSON.parse(rawResult.content[0].text);
        } catch {
          parsedResult = rawResult.content[0].text;
        }
      }

      const minimalResult = this.getMinimalToolOutput(toolName, parsedResult, uuid);
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
    uuid: string
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
    const ctx = await this.loadUserContext(uuid);
    const correctCartId = ctx?.cartId;

    console.log("correctCartId",correctCartId);
    console.log("args",args);
    

    if (correctCartId) {

      args.id=correctCartId;
      args.cartId = correctCartId;
      console.log("i called",args);

      // Some tools (like addGiftCardToCart) use "id"
      if (args.cartId && args.cartId !== correctCartId) {
        console.log("🔧 Fixing id → session cartId:", correctCartId);
        args.id = correctCartId;
      }
    }


    if (toolName === 'removeItemInCart') {
      console.log("🔍 removeItemInCart triggered");
    
      
      const match = this.findMatchingAddon(this.lastUserMessage, uuid);
    
      if (match) {
        console.log("✔ Matched addon:", match);
    
        args.itemId = match.id; // FORCE correct addon id from session
        args.id = ctx.cartId;
      } else {
        console.log("❌ No addon matched in sessionState.addonServices");
      }
    }
    


    if(toolName === 'resolveDateRange'){
      const result: any = await this.executeMCPToolAndBuildPayload(toolCall, uuid);
        
      // ✅ Parse correct payload for state extraction
      let parsedOutput :any= {};
      try {
        parsedOutput = JSON.parse(result.output);
        console.log("resolveDateRangeOutput",parsedOutput);
        this.lastResolvedDate = parsedOutput?.dates.resolvedDate;
        this.lastResolvedRangeLower = parsedOutput?.dates.rangeLower;
        this.lastResolvedRangeUpper = parsedOutput?.dates.rangeUpper;
      } catch {}
    }

    if(toolName === 'cartBookableDates'){
    console.log("i enetred cartBookableDates");
    console.log("lastResolvedRangeLower",this.lastResolvedRangeLower);
    console.log("lastResolvedRangeUpper",this.lastResolvedRangeUpper);
    args.searchRangeLower = this.lastResolvedRangeLower;
    args.searchRangeUpper = this.lastResolvedRangeUpper;
    }

    if(toolName === 'cartBookableTimes'){
      console.log("i enetred cartBookableTimes");
      args.searchDate = this.lastResolvedDate;
      }
  

        


    if (toolName === 'cartBookableStaffVariants') {

      console.log("i in cartBookableStaffVariants");
      
        const serviceItemId =  ctx?.serviceItemId;
      
        console.log("🔍 serviceItemId from session =", serviceItemId);
      
        if (serviceItemId) {
          // Force correct value
          args.itemId = serviceItemId;
          
          console.log("🔥 Overriding addServiceToCart args with correct serviceItemId:", serviceItemId);
        } else {
          console.warn("⚠️ WARNING: addServiceToCart called but serviceItemId is missing!");
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
          const result: any = await this.executeMCPToolAndBuildPayload(toolCall, uuid);
        
          // ✅ Parse correct payload for state extraction
          let parsedOutput = {};
          try {
            parsedOutput = JSON.parse(result.output);
          } catch {}
        
          // ✅ Extract cartId / email into session state
          this.extractStateFromToolOutput(parsedOutput, uuid);
        
          const item =  await this.loadUserContext(uuid);
          console.log("setClientOut >> ",item)
        
          return {
            reply: {
              role: "assistant",
              frontendAction: {
                type: "SHOW_PAY_BUTTON",
                checkoutUrl: `${process.env.CHECKOUT_LINK}/?email=${item.clientEmail}&amount=${item.totalAmount}&token=${item.sessionToken}`
              },
              content: "You're all set! Tap the button below to complete your payment."
            }
          };
        }
        
        
  
        // --------------------------------------------------------
        // 🔧 NORMAL TOOLS
        // --------------------------------------------------------
        const output = await this.executeMCPToolAndBuildPayload(toolCall, uuid);

        console.log("final outputs >> ",output);
        
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


  private findMatchingAddon(userMessage: string, uuid: string) {

    
    const state :any= this.contextCache.get(uuid) || {};
    console.log("state.addonServices >> ",state.booking.addonServices)

    

    if (!state || !state.booking.addonServices) return null;
  
    
    const msg = userMessage.toLowerCase();
  
    // Best match based on partial text search
    let bestMatch :any= null;
    let highestScore = 0;
  
    for (const addon of state.addonServices) {
      if (!addon?.name) continue;
  
      const name = addon.name.toLowerCase();
  

    

      // Simple partial match
      if (msg.includes(name)) {
     
        return addon; // strong match
      }
  
      // Fuzzy scoring (optional)
      let score = 0;
      const words = name.split(" ");
  
      words.forEach(w => {
        if (msg.includes(w)) score++;
      });
  
      if (score > highestScore) {
        highestScore = score;
        bestMatch = addon;
      }
    }
  
    
    // Return fuzzy match only if it was at least 1 hit
    return highestScore > 0 ? bestMatch : null;
  }
  
  
  private async extractStateFromToolOutput(toolOutput: any, uuid :string) {
    // console.log("🟦 extractStateFromToolOutput() CALLED ------------------------");
    // console.log("🔵 Raw toolOutput:", JSON.stringify(toolOutput, null, 2));
  
     // 🔥 STEP 1 — UNWRAP content[] text JSON
  if (Array.isArray(toolOutput?.content) && toolOutput.content[0]?.text) {
    try {
      const parsed = JSON.parse(toolOutput.content[0].text);
     toolOutput = parsed; // Replace wrapper with actual object
    } catch (err) {
      console.log("❌ Failed to parse content[0].text:", err);
    }
  }

  if (!toolOutput || typeof toolOutput !== 'object') {
    console.log("❌ toolOutput is empty or invalid");
    return;
  }

  const ctx = await this.loadUserContext(uuid);
  
    // if (!this.sessionState[sessionId]) this.sessionState[sessionId] = {};
    // const s = this.sessionState[sessionId];
  
    // console.log("🟡 Previous session state:", JSON.stringify(s, null, 2));
  
    // const preservedThreadId = s.threadId;
    // const preservedMessageCount = s.messageCount;
  
    const setIf = (k: keyof UserContext, v: any) => {
      if (k === 'threadId' || k === 'messageCount') return;
      if (v !== undefined && v !== null) {
        (ctx as any)[k] = v;
      }
    };
  
    // ----------------------- CART ID -----------------------
    // console.log("🔍 Checking for cartId sources...");
  
    if (typeof toolOutput.createCart?.cart?.id === 'string') {
      setIf('cartId', toolOutput.createCart.cart.id);
    }

    if (typeof toolOutput.listPrice === 'number') {
      setIf('totalAmount', toolOutput.listPrice/100);
    }
  
    if (typeof toolOutput.updateCart?.cart?.id === 'string') {
      setIf('cartId', toolOutput.updateCart.cart.id);
    
      if(toolOutput.updateCart.cart.summary){
        setIf('totalAmount', toolOutput.updateCart.cart.summary.total/100);
      }
    }
  
    if (typeof toolOutput.cartId === 'string') {
      setIf('cartId', toolOutput.cartId);
    }
  
    // ----------------------- PROMOTION -----------------------
    if (Array.isArray(toolOutput.offers) && toolOutput.offers[0]?.id) {
      setIf('promotionOfferId', toolOutput.offers[0].id);
    }
  
    if (toolOutput.addCartOffer?.offer?.id) {
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
  
        if (typeof top.id === 'string') setIf('serviceItemId', top.id);
        if (typeof top.staffVariantId === 'string') setIf('staffVariantId', top.staffVariantId);
      } else {
        console.log("⚪ No selectedItems found");
      }
    } catch (err) {
      console.log("❌ Error processing selectedItems", err);
    }


    // ----------------------- HANDLE addCartSelectedBookableItem -----------------------
if (toolOutput.addCartSelectedBookableItem?.cart?.selectedItems) {
  
  
  const sel = toolOutput.addCartSelectedBookableItem.cart.selectedItems;
  

  
  if (Array.isArray(sel) && sel.length > 0) {
    const top = sel[0];

    if (typeof top.id === 'string') setIf('serviceItemId', top.id);
    if (typeof top.staffVariantId === 'string') setIf('staffVariantId', top.staffVariantId);
  }
}

  
  
    // ----------------------- BOOKABLE TIME -----------------------
    try {
      const bookable =
        toolOutput.selectedBookableItem ||
        toolOutput.cart?.selectedBookableItem ||
        toolOutput.selected_bookable_item;
  
      if (bookable?.id) {
        setIf('bookableTimeId', bookable.id);
      } else {
        console.log("⚪ No selectedBookableItem found");
      }
    } catch (err) {
      console.log("❌ Error processing bookableTimeId", err);
    }

    console.log("clientinfo",toolOutput?.updateCart?.cart?.clientInformation);
    console.log("clientinfo2",toolOutput?.cart?.clientInformation);
    console.log("clientinfo3",toolOutput?.client?.email);
    

    if (toolOutput?.updateCart) {
      await this.saveClientInfo(uuid, toolOutput.updateCart?.cart?.clientInformation);
    }
  
    // ----------------------- EMAIL + TOTAL AMOUNT -----------------------
    try {
      const email =
        toolOutput.updateCart?.cart?.clientInformation?.email ||
        toolOutput.cart?.clientInformation?.email ||
        toolOutput.client?.email;
  
      if (email) {
       setIf('clientEmail', email);
      }
  
      const total =
        toolOutput.getCartSummary?.cart?.summary?.total ??
        toolOutput.cart?.summary?.total ??
        toolOutput.cart?.total;
  
      if (typeof total === 'number') {
        setIf('totalAmount', total / 100);
      }
    } catch (err) {
      console.log("❌ Error processing email/total", err);
    }


      // handle addonServices gather
      try {
        const selectedItems =
          toolOutput.selectedItems ||
          toolOutput.cart?.selectedItems ||
          toolOutput.addCartSelectedBookableItem?.cart?.selectedItems ||
          [];
  
        if (Array.isArray(selectedItems) && selectedItems.length > 0) {
          const addonServices: { id: string; name: string }[] = [];
          selectedItems.forEach((item: any) => {
            const optionGroups = item.item?.optionGroups || [];
            if (optionGroups.length > 0 && optionGroups[0].name?.toLowerCase() === "addon") {
              addonServices.push({
                id: item.id,
                name: item?.item?.name || item?.name
              });
            }
            if (Array.isArray(item.addons)) {
              item.addons.forEach((a: any) => {
                addonServices.push({ id: a.id, name: a.name });
              });
            }
          });
          // Fix: setIf("addonServices", ...) expects a keyof UserContext as the first argument,
          // so ensure 'addonServices' is a key of ctx/UserContext, or use correct key.
          // Let's use bracket notation and type assertion to avoid TypeScript error.
          if (addonServices.length > 0) {
            (setIf as any)('addonServices', addonServices);
          }
        }
      } catch (err) {
        console.log("❌ Error extracting addonServices", err);
      }
  
    await this.saveUserContext(uuid, ctx);

  }

  private async saveClientInfo(
    uuid: string,
    info: { email?: string; phone?: string; name?: string }
  ) {
    const ctx = await this.loadUserContext(uuid);
  
    
    if (!ctx.assistantType) {
      console.log("❌ No assistantType found. Cannot save client info.");
      return;
    }
  
    switch (ctx.assistantType) {
      case "booking":
        ctx.booking = ctx.booking || {};
        ctx.booking.clientInfo = {
          ...(ctx.booking.clientInfo || {}),
          ...info,
        };
        break;
  
      case "membership":
        ctx.membership = ctx.membership || {};
        ctx.membership.clientInfo = {
          ...(ctx.membership.clientInfo || {}),
          ...info,
        };
        break;
  
      case "giftcard":
        ctx.giftcard = ctx.giftcard || {};
        ctx.giftcard.clientInfo = {
          ...(ctx.giftcard.clientInfo || {}),
          ...info,
        };
        break;
  
      default:
        console.log("❌ Unknown assistantType:", ctx.assistantType);
    }

    console.log("new cartinfo",ctx);
    
  
    // 🔥 REMOVE OLD root-level fields (clientEmail etc.)
    delete ctx.clientEmail;
    delete ctx.awaitingClientDetails;
  
    await this.saveUserContext(uuid, ctx);
  }
  
  
  public async setPaymentToken(token: string, sessionId:string, uuid :string) {
    const c = await this.loadUserContext(uuid);
    
    if (!c?.cartId) throw new Error('Cart not available');
  
    const res=await this.mcpClient.callTool({ 
      name: 'addCartCardPaymentMethod', 
      arguments: { cartId: c.cartId, token, select: true } 
    });

    
    
    const checkoutResult: any = await this.mcpClient.callTool({ 
      name: 'checkoutCart', 
      arguments: { cartId: c.cartId } 
    });

     console.log("checkoutCart result",JSON.parse(checkoutResult.content[0].text?.checkoutCart));

    await this.extractStateFromToolOutput(checkoutResult, uuid);
    
    
    return checkoutResult;
  }

  // public clearSession(sessionId = 'default') {
  //   delete this.sessionState[sessionId];
  //   delete this.creatingThread[sessionId];
  // }

  async onModuleInit() {
   // await this.initMCP();
    // await this.initializeAssistantOnce();

    if (!process.env.BOOKING_ASSISTANT_ID)
      throw new Error("BOOKING_ASSISTANT_ID missing");
  
    if (!process.env.GIFT_ASSISTANT_ID)
      throw new Error("GIFT_ASSISTANT_ID missing");
  
    if (!process.env.MEMBERSHIP_ASSISTANT_ID)
      throw new Error("MEMBERSHIP_ASSISTANT_ID missing");
  

    console.log('🔍 OpenAI SDK initialized:', {
      hasBeta: !!this.openai?.beta,
      threadsRuns: !!this.openai?.beta?.threads?.runs,
    });
  }

  // async cleanupAfterCheckout(sessionId:any) {
  //   if (this.sessionState[sessionId]) {
  //     // delete this.sessionState[sessionId].threadId;
  //     // this.sessionState[sessionId].messageCount = 0;
  //     this.conversationHistory = null;
  //     delete this.sessionState[sessionId];
  //    // this.sessionToken = this.tokenGenerate(sessionId);
  //   }
  //   console.log("🧹 Thread cleaned for session:", this.sessionState);
  // }

  async cleanupAfterCheckout(uuid: string) {
    const ctx = await this.loadUserContext(uuid);
    if (ctx) {
      // Clear ephemeral things but keep the rest (preferences etc.)
      ctx.threadId = undefined;
      ctx.cartId = undefined;
      ctx.messageCount = 0;
      // Keep assistantType, preferences, last booked appointment etc.
      await this.saveUserContext(uuid, ctx);
    }
    console.log("🧹 Context cleaned for user:", uuid);
  }
}
