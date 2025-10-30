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

  async getResponse(
    userMessage: string,
    sessionId = 'default'
  ): Promise<{ reply: { role: string; content: string } }> {
    if (!this.conversationHistory[sessionId]) {
      this.conversationHistory[sessionId] = [
        {
          role: 'system',
          content: `
You are a **strict Boulevard booking assistant**.
Follow this structured workflow step by step and do not skip any validation.

1️⃣ GREETINGS / BOOKING START
   - When the user greets or says "book appointment", immediately call "get_locations".
   - When user provides a location, validate it. If valid, silently call "createAppointmentCart".

2️⃣ SERVICE SELECTION
   - Call "availableServices" to list services.
   - Use fuzzy matching client-side if needed.
   - Once service chosen, call "addServiceToCart".

3️⃣ DATE & TIME SELECTION
   - Always call "cartBookableDates" (never assume a date).
   - Show only a few readable options (YYYY-MM-DD).
   - After user picks a date, call "cartBookableTimes".
   - Confirm availability via "checkAvailability" before finalizing.

4️⃣ CLIENT & PAYMENT
   - After confirming time, gather client info then call "setClientOnCart" -> "tokenizeCard" -> "addCartCardPaymentMethod" -> "checkoutCart".

5️⃣ BEHAVIOR RULES
   - Keep responses short, polite, and guided.
   - Never invent dates/times.
   - Prefer calling MCP tools for truth.
          `,
        },
      ];
    }

    // save user message
    this.conversationHistory[sessionId].push({ role: 'user', content: userMessage });

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.5,
        messages: this.conversationHistory[sessionId],
        functions: this.getTools(),
        function_call: 'auto',
      });

      const message: any = completion?.choices?.[0]?.message || {};

      if (message.function_call) {
        const { name, arguments: args } = message.function_call;
        // parse function args if present
        let parsedArgs: Record<string, any> = args ? JSON.parse(args as string) : {};
        console.log(`⚙️ OpenAI requested tool: ${name}`, parsedArgs);

        // Recover common IDs from conversation history if missing (cartId, locationId, serviceId)
        const lastFunctionContent = this.conversationHistory[sessionId]
          .filter(m => m.role === 'function')
          .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .reverse()
          .join('\n');

        if (!parsedArgs.cartId) {
          const m = lastFunctionContent.match(/urn:blvd:Cart:[0-9a-fA-F-]+/);
          if (m) parsedArgs.cartId = m[0];
        }
        if (!parsedArgs.locationId) {
          const m = lastFunctionContent.match(/urn:blvd:Location:[0-9a-fA-F-]+/);
          if (m) parsedArgs.locationId = m[0];
        }
        if (!parsedArgs.serviceId) {
          const m = lastFunctionContent.match(/urn:blvd:Service:[0-9a-fA-F-]+/);
          if (m) parsedArgs.serviceId = m[0];
        }

        // Auto-fill date fields in proper YYYY-MM-DD format (Boulevard expects Date)
        const formatDate = (d: Date) => d.toISOString().split('T')[0];
        const today = new Date();
        const sevenDaysLater = new Date();
        sevenDaysLater.setDate(today.getDate() + 7);

        if (name === 'cartBookableDates') {
          const today = new Date();
          const sevenDaysLater = new Date(today);
          sevenDaysLater.setDate(today.getDate() + 7);
        
          const formatDate = (d: Date) => d.toISOString().split('T')[0];
        
          // 🚀 Always override, even if OpenAI provided values
          parsedArgs.searchRangeLower = formatDate(today);
          parsedArgs.searchRangeUpper = formatDate(sevenDaysLater);
        
          console.log('📅 Overriding date range →', {
            searchRangeLower: parsedArgs.searchRangeLower,
            searchRangeUpper: parsedArgs.searchRangeUpper,
          });
        }
        
        
// 🧠 Normalize natural language or short dates to proper ISO format
if (name === 'cartBookableTimes' && parsedArgs.searchDate) {
  const userDate = new Date(parsedArgs.searchDate);
  if (!isNaN(userDate.getTime())) {
    parsedArgs.searchDate = userDate.toISOString().split('T')[0];
  } else {
    console.warn('⚠️ Could not parse searchDate, using today instead');
    parsedArgs.searchDate = formatDate(today);
  }
}


        // make sure required IDs exist before calling the tool
        if ((name === 'cartBookableDates' || name === 'cartBookableTimes') && !parsedArgs.cartId) {
          const errMsg = 'Missing cartId. Create a cart first (createAppointmentCart) or provide cartId.';
          console.error(errMsg, parsedArgs);
          return { reply: { role: 'assistant', content: errMsg } };
        }

        try {
          // call the local MCP server tool
          const result: any = await this.mcpClient.callTool({
            name,
            arguments: parsedArgs,
          });

          const toolOutput =
            result?.content?.[0]?.text || JSON.stringify(result, null, 2);

          // store tool output for conversation context
          this.conversationHistory[sessionId].push({
            role: 'function',
            name,
            content: toolOutput,
          });

          // summarize tool output for the user
          const summary = await this.openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.6,
            messages: [
              {
                role: 'system',
                content: `Summarize the tool result in a short, polite message and stay in the booking flow.`,
              },
              { role: 'user', content: `Tool "${name}" returned: ${toolOutput}` },
            ],
          });

          const assistantMessage =
            summary?.choices?.[0]?.message?.content ||
            'Done.';

          this.conversationHistory[sessionId].push({
            role: 'assistant',
            content: assistantMessage,
          });

          return { reply: { role: 'assistant', content: assistantMessage } };
        } catch (err: any) {
          console.error(`❌ MCP tool ${name} failed:`, err);
          // return useful error message
          const msg = err?.message || `Something went wrong calling tool "${name}".`;
          return { reply: { role: 'assistant', content: msg } };
        }
      }

      // regular assistant message
      const responseText =
        typeof message?.content === 'string'
          ? message.content.trim()
          : 'Sorry, I could not process your request.';

      this.conversationHistory[sessionId].push({
        role: 'assistant',
        content: responseText,
      });

      return { reply: { role: 'assistant', content: responseText } };
    } catch (error: any) {
      console.error('❌ getResponse failed:', error);
      return {
        reply: {
          role: 'assistant',
          content:
            'An unexpected error occurred while processing your request. Please try again.',
        },
      };
    }
  }

  private getTools() {
    return [
      {
        name: 'get_locations',
        description: 'Fetch available Boulevard business locations for booking.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'createAppointmentCart',
        description: 'Create a booking cart for a specific location.',
        parameters: {
          type: 'object',
          properties: {
            locationId: { type: 'string', description: 'Boulevard location ID in URN format' },
          },
          required: ['locationId'],
        },
      },
      {
        name: 'availableServices',
        description: 'List available services in the user’s current cart.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string', description: 'Cart ID for the current session' },
          },
          required: ['cartId'],
        },
      },
      {
        name: 'addServiceToCart',
        description: 'Add selected service to the cart.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string' },
            serviceId: { type: 'string' },
          },
          required: ['cartId', 'serviceId'],
        },
      },
      // server defines these as cartBookableDates / cartBookableTimes
      {
        name: 'cartBookableDates',
        description: 'Fetch available booking dates for a selected service and location.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string' },
            locationId: { type: 'string' },
            searchRangeLower: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
            searchRangeUpper: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          },
          required: ['cartId', 'locationId', 'searchRangeLower', 'searchRangeUpper'],
        },
      },
      {
        name: 'cartBookableTimes',
        description: 'Fetch available time slots for a specific date and service.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string' },
            locationId: { type: 'string' },
            serviceId: { type: 'string' },
            searchDate: { type: 'string', description: 'Selected date (YYYY-MM-DD)' },
          },
          required: ['cartId', 'locationId', 'serviceId', 'searchDate'],
        },
      },
      {
        name: 'checkAvailability',
        description: 'Check appointment availability for the given service and date/time.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string' },
            serviceId: { type: 'string' },
            date: { type: 'string' },
            time: { type: 'string' },
          },
          required: ['cartId', 'serviceId'],
        },
      },
      {
        name: 'setClientOnCart',
        description: 'Attach client information to the cart.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            email: { type: 'string' },
            phoneNumber: { type: 'string' },
          },
          required: ['cartId', 'firstName', 'lastName', 'email', 'phoneNumber'],
        },
      },
      {
        name: 'tokenizeCard',
        description: 'Tokenize a credit card securely.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            number: { type: 'string' },
            cvv: { type: 'string' },
            exp_month: { type: 'number' },
            exp_year: { type: 'number' },
            address_postal_code: { type: 'string' },
          },
          required: ['name', 'number', 'cvv', 'exp_month', 'exp_year', 'address_postal_code'],
        },
      },
      {
        name: 'addCartCardPaymentMethod',
        description: 'Attach tokenized card to the cart for payment.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string' },
            token: { type: 'string' },
            select: { type: 'boolean', default: true },
          },
          required: ['cartId', 'token'],
        },
      },
      {
        name: 'checkoutCart',
        description: 'Complete the checkout and confirm booking.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string' },
          },
          required: ['cartId'],
        },
      },
    ];
  }
}
