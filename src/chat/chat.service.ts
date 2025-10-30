import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

@Injectable()
export class ChatService {
  private openai: OpenAI;
  private mcpClient: Client;
  private conversationHistory: Record<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]> = {};

  constructor() {
    this.initialize();
  }

  private async initialize() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/appointment-booking.js'],
      stderr: 'inherit',
    });

    this.mcpClient = new Client({
      name: 'blvd-mcp-client',
      version: '1.1.0',
    });

    await this.mcpClient.connect(transport);
    console.log('✅ Connected to MCP Server');
  }

  // 🧩 POST-TOOL ACTIONS (Enhanced Booking Flow)
  private postToolActions = {
    // Step 1: After service added, show available DATES dynamically
    addServiceToCart: async (sessionId: string, args: any) => {
      console.log('📅 Fetching available dates for service:', args.serviceId);

      let availableDates: string[] = [];

      try {
        const result: any = await this.mcpClient.callTool({
          name: 'checkAvailability',
          arguments: {
            cartId: args.cartId,
            serviceId: args.serviceId,
            date: new Date().toISOString().split('T')[0],
          },
        });

        const dataText = result?.content?.[0]?.text;
        const parsed = dataText ? JSON.parse(dataText) : result;
        availableDates = parsed?.dates || parsed?.availableDates || [];
      } catch (e) {
        console.error('⚠️ Failed to fetch available dates, falling back to 15-day range.');
      }

      if (!availableDates.length) {
        availableDates = Array.from({ length: 15 }).map((_, i) => {
          const d = new Date();
          d.setDate(d.getDate() + i);
          return d.toISOString().split('T')[0];
        });
      }

      const formattedDates = availableDates
        .slice(0, 15)
        .map((d) =>
          new Date(d).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          }),
        )
        .join('\n- ');

      const nextMsg = `✅ The service has been successfully added to your cart.
🗓️ Here are the available dates for the next 15 days:
- ${formattedDates}

Please tell me which date you'd like to book.`;

      this.conversationHistory[sessionId].push({ role: 'assistant', content: nextMsg });
      return nextMsg;
    },

    // Step 2: After date selected, show available TIMES dynamically
    checkAvailability: async (sessionId: string, args: any) => {
      if (!args.date) {
        return 'Please provide a date first before checking time availability.';
      }

      console.log(`🕐 Fetching available times for ${args.date}...`);

      try {
        const result: any = await this.mcpClient.callTool({
          name: 'cartBookableTimes',
          arguments: {
            cartId: args.cartId,
            serviceId: args.serviceId,
            searchDate: args.date,
          },
        });

        const dataText = result?.content?.[0]?.text;
        let parsed;
        if (
          typeof dataText === 'string' &&
          (dataText.trim().startsWith('{') || dataText.trim().startsWith('['))
        ) {
          parsed = JSON.parse(dataText);
        } else {
          parsed = result;
        }
        const timeSlots = parsed?.times || parsed?.availableTimes || parsed || [];

        if (!timeSlots.length) {
          const msg = `No time slots available for ${args.date}. Please choose another date.`;
          this.conversationHistory[sessionId].push({ role: 'assistant', content: msg });
          return msg;
        }

        const formattedTimes = timeSlots
          .slice(0, 8)
          .map((t: any) => {
            const timeStr = t.startTime || t.time || t;
            return new Date(timeStr).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
            });
          })
          .join('\n- ');

        const msg = `🕐 Available times for ${args.date}:
- ${formattedTimes}

Please choose a time slot to continue.`;

        this.conversationHistory[sessionId].push({ role: 'assistant', content: msg });
        return msg;
      } catch (e) {
        console.error('❌ Failed to fetch available times:', e);
        const msg = `Sorry, I couldn't fetch time slots right now. Please try again later.`;
        this.conversationHistory[sessionId].push({ role: 'assistant', content: msg });
        return msg;
      }
    },

    // Step 3: After time selected → show summary
    cartBookableTimes: async (sessionId: string, args: any) => {
      return this.showBookingSummary(sessionId, args.cartId);
    },
  };

  // 🧮 Utility: Format price values safely
  private formatMaybeCents = (val: any) => {
    if (val === null || val === undefined) return '0.00';
    const n = Number(val);
    if (Number.isNaN(n)) return '0.00';
    if (Math.abs(n) > 1000) return (n / 100).toFixed(2);
    return n.toFixed(2);
  };

  // 🧾 Step 4: Show booking summary
  private async showBookingSummary(sessionId: string, cartId: string) {
    console.log('📞 Calling MCP tool: getCartSummary with cartId =', cartId);
    try {
      const result: any = await this.mcpClient.callTool({
        name: 'getCartSummary',
        arguments: { cartId },
      });

      let data: any;
      if (result?.content?.[0]?.text) {
        try {
          data = JSON.parse(result.content[0].text);
        } catch {
          data = result;
        }
      } else {
        data = result;
      }

      const subtotal = this.formatMaybeCents(
        data?.display?.subtotal ??
          data?.cart?.summary?.subtotal ??
          data?.subtotal ??
          0,
      );
      const tax = this.formatMaybeCents(
        data?.display?.taxAmount ??
          data?.cart?.summary?.taxAmount ??
          data?.taxAmount ??
          0,
      );
      const total = this.formatMaybeCents(
        data?.display?.total ??
          data?.cart?.summary?.total ??
          data?.total ??
          0,
      );

      const summaryMsg = `
🧾 **Appointment Summary**
💰 Subtotal: $${subtotal}
💵 Tax: $${tax}
💳 Total: $${total}

Would you like to confirm this booking? (yes/no)
      `;

      this.conversationHistory[sessionId].push({ role: 'assistant', content: summaryMsg });
      return summaryMsg;
    } catch (error) {
      console.error('❌ Failed to show booking summary:', error);
      const errMsg = 'Unable to fetch your booking summary right now. Please try again.';
      this.conversationHistory[sessionId].push({ role: 'assistant', content: errMsg });
      return errMsg;
    }
  }

  // 💬 Core conversation handler
  async getResponse(userMessage: string, sessionId = 'default'): Promise<{ reply: { role: string; content: string } }> {
    if (!this.conversationHistory[sessionId]) {
      this.conversationHistory[sessionId] = [
        {
          role: 'system',
   

          content: `
          You are a **strict Boulevard booking assistant**.  
          Follow this structured workflow step-by-step and never skip any validation.
          
          ---
          
          ### 🟢 1️⃣ GREETING / BOOKING START
          
          - When the user says **hi**, **hello**, **hey**, **help**, or anything similar:  
            ➤ Politely greet them:  
            "Hello! I'm here to help you book an appointment. Would you like to book one?"
          
          - Wait for the user to respond.  
            - If they say **yes**, **ok**, or similar → call "get_locations".
            - If they say **no**, respond politely and end chat.
          
          - When a location is chosen, validate it from list.  
            - If invalid → show list again.  
            - Once valid → silently call "createAppointmentCart".
          
          ---
          
          ### 🟣 2️⃣ SERVICE SELECTION
          
          - After the cart is created, call "availableServices" and show list.
          - Match services using fuzzy matching (e.g., “hydra” → “Hydra Facial”).
          - Once the user selects a valid service → call "addServiceToCart".
          - After adding a service, show date options for booking.
          
          ---
          
          ### 🔵 3️⃣ DATE & TIME COLLECTION
          
          - Ask for a preferred appointment date.
          - When user provides a valid date → call time-slot logic or "checkAvailability".
          - Display available time slots.
          - When the user selects a time → verify it silently, and **then immediately show the booking summary** (do not ask for time again).
          - If available → confirm and proceed.
          
          ---
          
          ### ⚙️ 4️⃣ BEHAVIOR RULES
          - Be short, polite, guided.
          - Never skip ahead in the flow.
          - Always call tools instead of assuming data.
          - Never confirm booking until verified.
          
          ---
          `,
          
          
          
          
        }          
      ];
    }

    this.conversationHistory[sessionId].push({ role: 'user', content: userMessage });

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.5,
        messages: this.conversationHistory[sessionId],
        functions: this.getTools(),
        function_call: 'auto',
      });

      const message: any = completion?.choices?.[0]?.message;

      if (message.function_call) {
        const { name, arguments: args } = message.function_call;
        const parsedArgs = args ? JSON.parse(args as string) : {};
        console.log(`⚙️ Calling MCP tool: ${name}`, parsedArgs);

        try {
          const result: any = await this.mcpClient.callTool({ name, arguments: parsedArgs });
          const toolOutput = result?.content?.[0]?.text || JSON.stringify(result, null, 2);

          this.conversationHistory[sessionId].push({ role: 'function', name, content: toolOutput });

          let assistantMessage = 'Your request has been processed successfully.';
          if (this.postToolActions[name]) {
            assistantMessage = await this.postToolActions[name](sessionId, parsedArgs);
          }

          this.conversationHistory[sessionId].push({ role: 'assistant', content: assistantMessage });
          return { reply: { role: 'assistant', content: assistantMessage } };
        } catch (err) {
          console.error(`❌ MCP tool ${name} failed:`, err);
          return { reply: { role: 'assistant', content: `Something went wrong while calling "${name}". Please try again.` } };
        }
      }

      const text = typeof message?.content === 'string' ? message.content.trim() : 'Sorry, I could not process your request.';
      this.conversationHistory[sessionId].push({ role: 'assistant', content: text });
      return { reply: { role: 'assistant', content: text } };
    } catch (error) {
      console.error('❌ getResponse failed:', error);
      return { reply: { role: 'assistant', content: 'An unexpected error occurred while processing your request.' } };
    }
  }

  // 🔧 Tools available for OpenAI to call
  private getTools() {
    return [
      { name: 'get_locations', description: 'Fetch available Boulevard locations.', parameters: { type: 'object', properties: {} } },
      { name: 'createAppointmentCart', description: 'Create a booking cart for a selected location.', parameters: { type: 'object', properties: { locationId: { type: 'string' } }, required: ['locationId'] } },
      { name: 'availableServices', description: 'List services for a given cart.', parameters: { type: 'object', properties: { cartId: { type: 'string' } }, required: ['cartId'] } },
      { name: 'addServiceToCart', description: 'Add selected service to cart.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, serviceId: { type: 'string' } }, required: ['cartId', 'serviceId'] } },
      { name: 'checkAvailability', description: 'Check available dates for a service.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, serviceId: { type: 'string' }, date: { type: 'string' } }, required: ['cartId', 'serviceId', 'date'] } },
      { name: 'cartBookableTimes', description: 'Get available time slots for a date.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, serviceId: { type: 'string' }, date: { type: 'string' } }, required: ['cartId', 'serviceId', 'date'] } },
      { name: 'getCartSummary', description: 'Fetch cart summary details.', parameters: { type: 'object', properties: { cartId: { type: 'string' } }, required: ['cartId'] } },
      { name: 'checkoutCart', description: 'Complete and confirm booking.', parameters: { type: 'object', properties: { cartId: { type: 'string' } }, required: ['cartId'] } },
    ];
  }
}
