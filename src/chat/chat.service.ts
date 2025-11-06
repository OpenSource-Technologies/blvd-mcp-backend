import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The BookingIntent interface is no longer strictly necessary for state management, 
// but we keep it here to define the structure of the data the AI *implicitly* manages.
interface BookingIntent {
  service?: string;
  location?: string;
  date?: string;
  time?: string;
  esthetician?: string;
}

@Injectable()
export class ChatService {
  private openai: OpenAI;
  private mcpClient: Client;
  // conversationHistory now stores messages only; state is managed by the AI's reasoning.
  private conversationHistory: Record<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]> = {};

  constructor() {
    this.initialize();
  }

  private async initialize() {
    // Ensure API Key is available
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    // Setup MCP Client Transport
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/appointment-booking.js'],
      stderr: 'inherit',
    });

    // Logging for the MCP server process
    // @ts-ignore
    transport.process?.stdout?.on('data', (data: Buffer) => {
      console.log('🪶 [MCP SERVER STDOUT]:', data.toString().trim());
    });
    // @ts-ignore
    transport.process?.stderr?.on('data', (data: Buffer) => {
      console.error('🔥 [MCP SERVER STDERR]:', data.toString().trim());
    });

    this.mcpClient = new Client({
      name: 'blvd-mcp-client',
      version: '1.1.0',
    });

    await this.mcpClient.connect(transport);
    console.log('✅ Connected to MCP Server');
  }

  // Helper to define the full list of available tools (MCP functions) for OpenAI
  private getBookingTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'getLocations',
          description: 'Fetches all available locations for booking. Use this first.',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'createAppointmentCart',
          description: 'Creates a new booking cart for a specified location. Requires locationId.',
          parameters: {
            type: 'object',
            properties: { locationId: { type: 'string', description: 'The ID of the selected location.' } },
            required: ['locationId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'availableServices',
          description: 'Fetches all available services for the current cart/location. Requires cartId.',
          parameters: {
            type: 'object',
            properties: { cartId: { type: 'string', description: 'The ID of the current cart.' } },
            required: ['cartId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'addServiceToCart',
          description: '**CRITICAL STEP:** Adds a chosen service to the cart. This MUST be called immediately after identifying the service from the `availableServices` list. Requires cartId and the serviceId.',
          
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              serviceId: { type: 'string', description: 'The ID of the service to add.' },
            },
            required: ['cartId', 'serviceId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cartBookableDates',
          description: 'Fetches available booking dates for the selected service in the cart. Requires cartId.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              // Note: The AI should decide the range or rely on a default if not specified.
              searchRangeLower: { type: 'string', description: 'Start date for search (YYYY-MM-DD).' },
              searchRangeUpper: { type: 'string', description: 'End date for search (YYYY-MM-DD).' },
            },
            required: ['cartId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cartBookableTimes',
          description: 'Fetches available time slots for the selected date and service. Requires cartId and searchDate.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              searchDate: { type: 'string', description: 'The date to search for times (YYYY-MM-DD).' },
            },
            required: ['cartId', 'searchDate'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'reserveCartBookableItems',
          description: 'Reserves the chosen time slot in the cart. Required after date/time selection. Requires cartId and bookableTimeId.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              bookableTimeId: { type: 'string', description: 'The ID of the specific time slot to reserve.' },
            },
            required: ['cartId', 'bookableTimeId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cartBookableStaffVariants',
          description: 'Fetches available staff for the reserved service/time slot. Requires cartId, serviceItemId (the ID of the item *in the cart*), and bookableTimeId.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string', description: 'The cart ID.' },
              itemId: { type: 'string', description: 'The selected item ID *in the cart* (use selectedItems[N].id).' },
              bookableTimeId: { type: 'string', description: 'The ID of the reserved time slot.' },
            },
            required: ['cartId', 'itemId', 'bookableTimeId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'updateCartSelectedBookableItem',
          description: 'Assigns a staff member to the reserved service. Requires cartId, itemId, and staffVariantId.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              itemId: { type: 'string', description: 'The selected item ID *in the cart*.' },
              staffVariantId: { type: 'string', description: 'The ID of the chosen staff variant.' },
            },
            required: ['cartId', 'itemId', 'staffVariantId'],
          },
        },
      },

    try {
      console.log("fullIntent >> ",completion.choices[0].message)
      return JSON.parse(completion.choices[0].message.content || '{}');
    } catch {
      return {};
    }
  }
// Inside ChatService class:
// Inside ChatService class:
// Inside ChatService class:
// Inside ChatService class:
// Inside ChatService class:

private buildSystemPrompt(): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    
  const getTodayDate = () => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  };


  
  return {
    role: 'system',
    content: `
You are a highly flexible, intelligent, and conversational appointment booking AI. Your primary tool is the list of functions provided to manage the booking state through a commerce cart system (Model Context Protocol).

**NOTE ON CONTEXT MEMORY:** To save on context size, I will occasionally **internally summarize** the current booking state (Location, Cart ID, Service ID, Time ID) and replace the verbose history with this summary. **You must always rely on the most recent information provided, whether it is a full history or a concise state summary message.**

## CORE DIRECTIVES FOR FLEXIBILITY & STATE MANAGEMENT:

1.  **Goal:** Guide the user to a fully confirmed appointment.
2.  **Scope Guardrail:** Your function is strictly limited to booking **salon, spa, or similar personal care services**. If the user attempts to book anything outside this scope (e.g., "cricket match," "flight," "pizza"), you must politely inform them that you can only assist with **appointment booking for services** and ask them to specify the service they want.
3.  **State Management:** You are responsible for maintaining the state of the booking (Location ID, Cart ID, Service Item ID, Date, Time, Staff Variant ID) by intelligently reasoning over the conversation history and the JSON results from the function calls. **You must track these IDs mentally/contextually.**
4.  **Conversational Flexibility:**
  * **Status Check:** If the user asks for *any* current selection (e.g., "What location did I choose?", "What time is selected?"), respond conversationally with the current known state. **Do not make a function call for status checks unless necessary to retrieve a detail (like the full cart summary).**
  * **Change Request:** If the user asks to change an item (e.g., "Change my service to X"), use the appropriate function to update the cart state (e.g., \`addServiceToCart\`, or by changing the selected date/time/staff).
  * **Intent Injection:** If the user provides multiple details at once (e.g., "Book a haircut at the First Sandbox location tomorrow at 3pm"), immediately call the necessary functions in the correct order to validate and set all the provided details.
5.  **Booking Flow Order:** The logical sequence is strict: **Location → Create Cart → Service ID Acquisition → CRITICAL: Service Commitment (Add to Cart) → Date → Time → CRITICAL: Reserve Time Slot → Staff → Summary & Confirmation.** Only call a function when the required data for that step is missing or needs validation/update.
  * **CRITICAL STEP CHAINING 1 (Service):** After successfully running the \`availableServices\` tool, you **MUST immediately take a conversational turn** to present the options to the user before proceeding. You **MUST NOT** call \`addServiceToCart\` in the same turn.
  * **CRITICAL STEP CHAINING 2 (Time):** After successfully receiving a list of available times from \`cartBookableTimes\`, you **must immediately** call \`reserveCartBookableItems\` using the chosen time ID to secure the slot before proceeding to staff selection. Staff cannot be selected until a time slot is reserved.
6.  **CRITICAL DATE CONSTRAINT (USE USER'S DATE):** **If the user explicitly provides a date (e.g., '7 nov'), you MUST use that date (YYYY-MM-DD format) for all subsequent date-related tool calls** (\`cartBookableDates\`, \`cartBookableTimes\`). You must only default to starting the search from **today's date, ${getTodayDate()}**, if *no* specific date is mentioned by the user. **NEVER** override the user's specific future date with the current date.
7.  **CRITICAL ID CLARIFICATION:** When identifying the service item ID for **\`cartBookableStaffVariants\`** or **\`updateCartSelectedBookableItem\`**, you must use the **top-level \`id\`** of the object in the cart's \`selectedItems\` array. **NEVER** use the nested \`item.id\` field, as it is the wrong identifier for booking staff.
8.  **Error Handling:** If a function call returns an error or an empty list (e.g., no available times), clearly inform the user and ask them to choose a different option.
9.  **Presentation:** Use clear, formatted lists (using Markdown bullets or numbering) when presenting options to the user (locations, services, dates, times).
10. **CRITICAL CURRENCY CLARIFICATION (FIXED):** When reporting any monetary values (prices, subtotals, taxes, totals) from the API (like \`getCartSummary\`), you **MUST** assume the number is in **cents (USD)**.  
To display the final price in the standard format (**$X.XX**), you must:

* **Divide the number by 100.**
* **Format the result with a dollar sign ($) and two decimal places.**


*Example:* If the API returns \`1000\`, display **$10.00**.  
If the API returns \`105000\`, display **$1,050.00**.

## 🛑 MANDATORY CLARIFICATION RULES (FIXED)

11. **STRICT SERVICE MATCHING (MANDATORY LISTING/STOP):**
  * **ABSOLUTE RULE:** After the tool call for \`availableServices\` returns a JSON result, you **MUST immediately respond conversationally** by listing all service options. You **MUST NOT** call \`addServiceToCart\` in that same turn.
  * **Your response MUST** list all service options found in the \`availableServices\` output, including their full names and price/duration (if available in the output).
  * **Explicitly ask the user to select the specific service name or number** they wish to book. The subsequent step, \`addServiceToCart\`, can only be executed after the user provides this explicit selection.

12. **MANDATORY LOCATION SELECTION (NO DEFAULTING):**
  * **ABSOLUTE RULE:** The first step in any new booking flow **MUST** be to establish the location. If the user has not specified a location, you **MUST** call \`getLocations\`, then **list all available locations** to the user, and **explicitly ask them to choose one** before calling \`createAppointmentCart\`. **DO NOT select any location by default, even if only one is available.**

13. **TIME SLOT ENFORCEMENT (AUTO-SELECT IF AVAILABLE):**
  * **If the user explicitly provided a time in their initial query (e.g., '9am'), and that time is available in the \`cartBookableTimes\` output, you MUST automatically reserve that time slot using \`reserveCartBookableItems\` in the next tool call without asking the user again.**
  * If the user provided a date but **NO time**, or if their specified time is **NOT available**, you **MUST** display the available time slots to the user in a clear, formatted list, and explicitly **ask the user to select their desired time**.

14. **MANDATORY CLIENT DETAILS COLLECTION:**
    * **After staff selection is complete, you MUST take a conversational turn to ask the user for their contact details (First Name, Last Name, Email, and Phone Number) before calling \`setClientOnCart\` or proceeding to final summary/payment.** You must obtain all four pieces of information before calling \`setClientOnCart\`.
15.  **🛑 CRITICAL CART ID INTEGRITY (CHECK FOR CORRUPTION) 🛑:**
    * The **Cart ID** is established *only* by the **\`createAppointmentCart\`** tool and always begins with **\`urn:blvd:Cart:\`**, followed by a long unique identifier.
    * ⚠️ **NEVER EVER** use a truncated Cart ID (for example, **\`urn:blvd:Cart:\`**).  
      You **MUST** use the complete ID (for example, **\`urn:blvd:Cart:ac67fb72-8c8f-4cef-b992-b9f9ffdfa510\`**) when calling **\`setClientOnCart\`**, **\`getCartSummary\`**, or **\`confirmBooking\`**.
    * If the Cart ID is missing, incomplete, or corrupted, you **MUST** inform the user that the cart session is invalid and that the booking process must restart.

`,
  };
}

// ... the rest of the ChatService class is unchanged.

// ... the rest of the ChatService class is unchanged.
// ... the rest of the ChatService class is unchanged.
// ... the rest of the ChatService class is unchanged.
  
  // New function for programmatic state extraction
  private extractStateFromHistory(history: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): string {
    const state: Record<string, string> = {};

    // Iterate history in reverse to find the most recent state updates
    for (let i = history.length - 1; i >= 0; i--) {
        const message :any= history[i];

        if (message.role === 'tool' && message.content) {
            try {
                const toolOutput = JSON.parse(message.content);
                
                // --- Programmatic Extraction Logic ---
                
                // 1. Cart ID / Location ID (Prioritize non-empty values)
                if (toolOutput.cartId && !state.cartId) state.cartId = toolOutput.cartId;
                if (toolOutput.locationId && !state.locationId) state.locationId = toolOutput.locationId;
                
                // 2. Service Item ID (The top-level ID of the item *in the cart*)
                // This is a crucial ID after addServiceToCart
                if (toolOutput.selectedItems && toolOutput.selectedItems.length > 0) {
                    const itemId = toolOutput.selectedItems[0].id;
                    if (itemId && !state.serviceItemId) state.serviceItemId = itemId;
                }
                
                // 3. Bookable Time ID (from reserveCartBookableItems or other cart updates)
                // Look for the specific ID of the reserved slot
                if (toolOutput.selectedBookableItem?.id && !state.bookableTimeId) {
                    state.bookableTimeId = toolOutput.selectedBookableItem.id;
                }
                
                // 4. Staff Variant ID (from updateCartSelectedBookableItem result)
                // Staff ID might be nested or a direct property depending on the tool result structure
                // Assuming it's often linked to the selectedItem's staffVariantId after assignment
                if (toolOutput.selectedItems && toolOutput.selectedItems.length > 0 && toolOutput.selectedItems[0].staffVariantId) {
                   if (!state.staffVariantId) state.staffVariantId = toolOutput.selectedItems[0].staffVariantId;
                }
                // If all critical IDs are found, we can stop early
                if (state.cartId && state.serviceItemId && state.bookableTimeId && state.staffVariantId) {
                    break;
                }
                
            } catch (e) {
                // Ignore tool messages that are not valid JSON or don't contain key state info
            }
        }
    }

    // Format the state into a concise string for the LLM
    const summary = Object.entries(state)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
        
    return summary;
  }


  isDateString(value: any): any {
    return !isNaN(Date.parse(value));
  }

  isTimeFormat(str: string): any {
    const regex = /^(0?[1-9]|1[0-2]):?[0-5]?\d?\s?(AM|PM)$/i;
    return regex.test(str.trim());
  }
  

  async getResponse(userMessage: string, sessionId = 'default') {
    if (!this.conversationHistory[sessionId]) {
      // Initialize with the comprehensive system prompt
      this.conversationHistory[sessionId] = [this.buildSystemPrompt()];
    }

    // Add the user's latest message to the history
    this.conversationHistory[sessionId].push({ role: 'user', content: userMessage });

    // Extract intent from user message
    const intent = await this.extractBookingIntent(userMessage);
    console.log('🧠 Extracted Intent:', intent);
    if(Object.keys(intent).length === 0){
      if (this.isDateString(userMessage)) {
        intent.date = userMessage;
      }

      if(this.isTimeFormat(userMessage)){
        intent.time = userMessage;
      }
      console.log("empty intent = ",userMessage)
      console.log("intent innn ",intent)
    }else{
      console.log("not emopty intent")
    }
// 🧠 Merge with previous session intent memory
const prevIntent =
  this.conversationHistory[sessionId + '_intent'] || {};

//const mergedIntent = { ...prevIntent, ...intent };

let mergedIntent:any = { ...intent };

for (const [key, value] of Object.entries(prevIntent)) {
  if (value !== null && value !== undefined) mergedIntent[key] = value;
}


console.log("prevIntent  >> ",prevIntent);
console.log("mergedIntent initial >> ",mergedIntent)

// Save merged intent back into memory
this.conversationHistory[sessionId + '_intent'] = mergedIntent;

console.log(`🧠 Merged Intent: ${JSON.stringify(mergedIntent, null, 2)}`);

    // ========================================
    // STEP 1: Always fetch locations first (MANDATORY)
    // ========================================
    let locations = (this as any).conversationHistory[sessionId + '_locations'];
    
    // CRITICAL: Check and prune history before starting the main loop
    await this.pruneHistoryForState(sessionId);

    let response: OpenAI.Chat.Completions.ChatCompletion = null as any;
    // Set a loop limit to prevent runaway function calls
    for (let i = 0; i < 15; i++) {
      console.log(`\n➡️ LLM Call ${i + 1}: Sending ${this.conversationHistory[sessionId].length} messages...`);

      try {
        const result: any = await this.mcpClient.callTool({
          name: 'get_locations',
          arguments: {},
        });
      } catch (error) {
        console.error('❌ OpenAI API Call Failed:', error);
        return { reply: { role: 'assistant', content: 'I apologize, there was an error connecting to my core services. Please try again in a moment.' } };
      }

      const message = response.choices[0].message;

      if (message.tool_calls) {
        // --- AI wants to call a function ---
        this.conversationHistory[sessionId].push(message); // Save AI's decision to call a tool
        console.log(`⚙️ Tool Call(s) requested: ${message.tool_calls.map((tc :any)=> tc.function.name).join(', ')}`);

    // ========================================
    // STEP 3: Create cart if not exists
    // ========================================
    let cartId = (this as any).conversationHistory[sessionId + '_cartId'];

    if (!cartId) {
      try {
        const cartResult: any = await this.mcpClient.callTool({
          name: 'createAppointmentCart',
          arguments: { locationId: selectedLocation.id },
        });

        const cartText = cartResult?.content?.[0]?.text;
        const cartData = JSON.parse(cartText || '{}');
        cartId = cartData?.createCart?.cart?.id || cartData?.cartId;
        
        if (!cartId) throw new Error('No cartId returned');
        
        (this as any).conversationHistory[sessionId + '_cartId'] = cartId;
        console.log('✅ Cart created:', cartId);
      } catch (err) {
        console.error('❌ createAppointmentCart failed:', err);
        return { reply: { role: 'assistant', content: 'Failed to create booking cart. Please try again.' } };
      }
    }

    // ========================================
    // STEP 4: Handle service selection
    // ========================================
    let selectedService = (this as any).conversationHistory[sessionId + '_selectedService'];
    console.log("selectedService >> ",selectedService)

    if (!selectedService) {
      // Fetch available services if not already fetched
      let services = (this as any).conversationHistory[sessionId + '_services'];
      
      if (!services) {
        try {
          const svcResult: any = await this.mcpClient.callTool({
            name: 'availableServices',
            arguments: { cartId },
          });

          let svcText = svcResult?.content?.[0]?.text;
          let svcData = typeof svcText === 'string' ? JSON.parse(svcText) : svcText;
          const excluded = ['Memberships', 'packages', 'products', 'Gift Cards'];

          services = svcData?.cart?.availableCategories
            ?.filter((c: any) => !excluded.includes(c?.name))
            ?.flatMap((c: any) => c?.availableItems || []) || [];

          (this as any).conversationHistory[sessionId + '_services'] = services;

          if (!services.length) {
            return { reply: { role: 'assistant', content: `No services available at ${selectedLocation.name}.` } };
          }
        } catch (err) {
          console.error('❌ availableServices failed:', err);
          return { reply: { role: 'assistant', content: 'Failed to fetch services. Please try again.' } };
        }
      }
      console.log('🧠 Extracted Intent:', intent);

      
      console.log("intent service",intent);
      console.log("mergedIntent service>> ",mergedIntent)
      
      // Check if user provided service in their message
      if (mergedIntent.service) {
        const match = this.findBestMatch(mergedIntent.service, services, 'name');
        if (match) {
          selectedService = match;
          (this as any).conversationHistory[sessionId + '_selectedService'] = selectedService;
          delete (this as any).conversationHistory[sessionId + '_services'];
          console.log('✅ Auto-matched service:', selectedService.name);
          
          // Add service to cart immediately
          try {
            // --- Parse arguments safely ---
            funcArgs = JSON.parse(toolCall.function.arguments || '{}');
            console.log(`🛠️ Executing MCP Tool: ${funcName}`);
            console.log(`📦 Arguments: ${JSON.stringify(funcArgs, null, 2)}`);
        
            // --- Execute the tool via MCP client ---
            const result: any = await this.mcpClient.callTool({
              name: funcName,
              arguments: funcArgs,
            });
            console.log(JSON.stringify(result, null, 2));

            const selectedServiceList = JSON.parse(result?.content?.[0]?.text || '[]');
            const selectedServiceId = selectedServiceList?.addCartSelectedBookableItem?.cart?.selectedItems?.[0]?.id;

            if (!selectedServiceId) throw new Error('No selectedServiceId returned');

            (this as any).conversationHistory[sessionId + '_selectedServiceId'] = selectedServiceId;
            console.log('✅ Service added to cart:', selectedServiceId);
            
            // Don't return here - continue to date selection below
          } catch (err) {
            console.error('❌ addServiceToCart failed:', err);
            return { reply: { role: 'assistant', content: `Couldn't add ${selectedService.name} to cart. Please try again.` } };
          }
        } else {
          // Service mentioned but not found
          const list = services.map((s: any, i: number) => `${i + 1}. ${s.name}`).join('\n');
          return {
            reply: {
              role: 'assistant',
              content: `I couldn't find "${intent.service}". Here are the available services at ${selectedLocation.name}:\n${list}\n\nPlease choose one by typing the number or name.`,
            },
          };
        }
      } else {
        // No service mentioned, show options
        const list = services.map((s: any, i: number) => `${i + 1}. ${s.name}`).join('\n');
        return {
          reply: {
            role: 'assistant',
            content: `Here are the available services at ${selectedLocation.name}:\n${list}\n\nPlease choose one by typing the number or name.`,
          },
        };
      }
    }

    // ========================================
    // STEP 5: Handle date selection
    // ========================================
    let selectedDate = (this as any).conversationHistory[sessionId + '_selectedDate'];
  
    if (!selectedDate) {
      let bookableDates = (this as any).conversationHistory[sessionId + '_bookableDates'];

      if (!bookableDates) {
        try {
          const today = new Date();
          const lower = today.toISOString().split('T')[0];
          const upper = new Date(today.getTime() + 7 * 86400000).toISOString().split('T')[0];

          const result: any = await this.mcpClient.callTool({
            name: 'cartBookableDates',
            arguments: { cartId, searchRangeLower: lower, searchRangeUpper: upper },
          });

          bookableDates = JSON.parse(result?.content?.[0]?.text || '[]');
          (this as any).conversationHistory[sessionId + '_bookableDates'] = bookableDates;

          if (!bookableDates.length) {
            return { reply: { role: 'assistant', content: 'No available dates in the next 7 days. Please try again later.' } };
          }
        } catch (err) {
          console.error('❌ cartBookableDates failed:', err);
          return { reply: { role: 'assistant', content: 'Failed to fetch available dates. Please try again.' } };
        }
      }

      // Check if user provided date in their message
      console.log("mergedIntent  >> ",mergedIntent);
      if (mergedIntent.date) {
        const parsedDate = this.parseDate(mergedIntent.date);
        const match = bookableDates.find((d: string) => d === parsedDate || d.includes(parsedDate));
        
        if (match) {
          selectedDate = match;
          (this as any).conversationHistory[sessionId + '_selectedDate'] = selectedDate;
          delete (this as any).conversationHistory[sessionId + '_bookableDates'];
          console.log('✅ Auto-matched date:', selectedDate);
          
          // Don't return here - continue to time selection below
        } else {
          // Date mentioned but not available
          const list = bookableDates.map((d: string, i: number) => `${i + 1}. ${d}`).join('\n');
          return {
            reply: {
              role: 'assistant',
              content: `"${match}" is not available. Here are the available dates:\n${list}\n\nPlease choose one by typing the number or date.`,
            },
          };
        }
      } else {
        // No date mentioned, show options
        const list = bookableDates.map((d: string, i: number) => `${i + 1}. ${d}`).join('\n');
        return {
          reply: {
            role: 'assistant',
            content: `Great! Here are the available dates for ${selectedService.name}:\n${list}\n\nPlease choose one by typing the number or date.`,
          },
        };
      }
    }

    // ========================================
    // STEP 6: Handle time selection
    // ========================================
    let selectedTimeSlot = (this as any).conversationHistory[sessionId + '_selectedTimeSlot'];

    if (!selectedTimeSlot) {
      let bookableTimes = (this as any).conversationHistory[sessionId + '_bookableTimes'];

      if (!bookableTimes) {
        try {
          const result = await this.mcpClient.callTool({
            name: 'cartBookableTimes',
            arguments: { cartId, searchDate: selectedDate },
          });

          bookableTimes = JSON.parse(result?.content?.[0]?.text || '[]');
          (this as any).conversationHistory[sessionId + '_bookableTimes'] = bookableTimes;

          if (!bookableTimes.length) {
            return { reply: { role: 'assistant', content: `No available times on ${selectedDate}. Please choose another date.` } };
          }
        } catch (err) {
          console.error('❌ cartBookableTimes failed:', err);
          return { reply: { role: 'assistant', content: 'Failed to fetch available times. Please try again.' } };
        }
      }

      // Check if user provided time in their message
      if (mergedIntent.time) {
        // Match time (flexible: "6am", "06:00", "6:00 AM", etc.)
        const match = bookableTimes.find((slot: any) => {
          const slotTime = new Date(slot.startTime);
          const hourMin = slotTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          const hour12 = slotTime.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).toLowerCase();
          
          return hourMin.includes(mergedIntent.time!) || 
                 hour12.includes(mergedIntent.time!.toLowerCase()) ||
                 slot.startTime.includes(mergedIntent.time!);
        });


        console.log("match time >> ",match)

        if (match) {
          selectedTimeSlot = match;
          (this as any).conversationHistory[sessionId + '_selectedTimeSlot'] = selectedTimeSlot;
          delete (this as any).conversationHistory[sessionId + '_bookableTimes'];
          console.log('✅ Auto-matched time:', selectedTimeSlot.startTime);

          // Reserve the time slot
          try {
            await this.mcpClient.callTool({
              name: 'reserveCartBookableItems',
              arguments: { cartId, bookableTimeId: selectedTimeSlot.id },
            });
          }
        } else {

          const time = mergedIntent.time;
          const [hours, minutes] = time.split(':').map(Number);
          
          const date = new Date();
          date.setHours(hours, minutes);
          
          const formatted = date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });


          // Time mentioned but not available
          const list = bookableTimes.map((t: any, i: number) => 
            `${i + 1}. ${new Date(t.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          ).join('\n');
          return {
            reply: {
              role: 'assistant',
              content: `"${formatted}" is not available on ${selectedDate}. Here are the available times:\n${list}\n\nPlease choose one by typing the number.`,
            },
          };
        }
      } else {
        // No time mentioned, show options
        const list = bookableTimes.map((t: any, i: number) => 
          `${i + 1}. ${new Date(t.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        ).join('\n');
        return {
          reply: {
            role: 'assistant',
            content: `Here are the available times on ${selectedDate}:\n${list}\n\nPlease choose one by typing the number.`,
          },
        };
      }
    }

    // ========================================
    // STEP 7: Handle esthetician selection
    // ========================================
    let selectedStaff = (this as any).conversationHistory[sessionId + '_selectedStaff'];

    if (!selectedStaff) {
      let staffList = (this as any).conversationHistory[sessionId + '_staffList'];
      const selectedServiceId = (this as any).conversationHistory[sessionId + '_selectedServiceId'];

      if (!staffList) {
        try {
          const staffResult: any = await this.mcpClient.callTool({
            name: 'cartBookableStaffVariants',
            arguments: { id: cartId, itemId: selectedServiceId, bookableTimeId: selectedTimeSlot.id },
          });
        }
        
        // Loop again: The next iteration will allow the AI to read the tool result and decide the next step (another tool or final text reply)
      } else {
        // --- AI responds with final text ---
        this.conversationHistory[sessionId].push(message);
        console.log('🗣️ LLM replied with text. End of turn.');
        return { reply: message };
      }
    }

    // Safety fallback if the loop limit is reached
    return { reply: { role: 'assistant', content: 'I seem to be stuck in a complex sequence. Could you please simplify your request or state the detail you want to change?' } };

  }}