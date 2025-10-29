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

  async getResponse(userMessage: string, sessionId = 'default'): Promise<string> {
    if (!this.conversationHistory[sessionId]) {
      this.conversationHistory[sessionId] = [
        {
          role: 'system',
          content: `
        You are a **strict Boulevard booking assistant**. 
        Follow this structured workflow step by step and do not skip any validation.
        
        1️⃣ **GREETINGS / BOOKING START**
           - When the user says hi, hello, or anything like "book appointment", IMMEDIATELY call the "get_locations" MCP tool to fetch available locations.
           - When the user provides a location, check if it’s valid among the available list.
           - If invalid, re-show available options.
           - Once a valid location is chosen, silently call "createAppointmentCart" (do not mention this to the user).
        
        2️⃣ **SERVICE SELECTION**
           - Call "availableServices" to show services for that location.
           - Match the user-entered service using fuzzy matching (e.g., “hydra” → “Hydra Facial”).
           - If the service is not found, re-show available services until a valid match is confirmed.
        
        3️⃣ **DATE & TIME COLLECTION**
           - Ask the user for a preferred appointment date.
           - Once a valid date is given, call a time-slot-related tool or logic to fetch available time slots for that date.
           - Display the available time slots to the user and ask them to choose one.
           - When the user picks a time, call "checkAvailability" to verify that the slot is open.
           - If unavailable, show the next available options.
           - If available, confirm and proceed to the next step.
        
        4️⃣ **BEHAVIOR RULES**
           - Always be short, polite, and guided.
           - Never jump ahead in the booking flow.
           - Always prefer calling MCP tools over assumptions.
           - Never assume a date/time without verification.
           - Never confirm booking until availability is verified.
          `,
        },
      ];
    }

    this.conversationHistory[sessionId].push({ role: 'user', content: userMessage });

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: this.conversationHistory[sessionId],
      functions: this.getTools(),
      function_call: 'auto',
    });

    const message = completion.choices[0].message;

    if (message.function_call) {
      const { name, arguments: args } = message.function_call;
      const parsedArgs = args ? JSON.parse(args as string) : {};
      console.log(`⚙️ Calling MCP tool: ${name}`, parsedArgs);

      try {
        const result = await this.mcpClient.callTool({
          name,
          arguments: parsedArgs,
        });

        const toolOutput = result?.content?.[0]?.text || JSON.stringify(result, null, 2);

        this.conversationHistory[sessionId].push({
          role: 'function',
          name,
          content: toolOutput,
        });

        const finalReply = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.6,
          messages: [
            {
              role: 'system',
              content: `
Summarize the tool result in a short, friendly user-facing message.
Stay inside the booking flow context.
If this was an internal tool call (like creating a cart), do not expose it to the user.`,
            },
            { role: 'user', content: `Tool "${name}" returned: ${toolOutput}` },
          ],
        });

        const assistantReply = finalReply.choices[0].message.content || toolOutput;
        this.conversationHistory[sessionId].push({ role: 'assistant', content: assistantReply });
        return assistantReply;
      } catch (err: any) {
        console.error(`❌ MCP tool ${name} failed:`, err);
        return `Error executing tool "${name}": ${err.message}`;
      }
    }

    if (message.content) {
      this.conversationHistory[sessionId].push({ role: 'assistant', content: message.content });
    }

    return message.content || 'Sorry, I could not process your request.';
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
        name: 'checkAvailability',
        description: 'Check appointment availability for the given service and date/time.',
        parameters: {
          type: 'object',
          properties: {
            cartId: { type: 'string' },
            serviceId: { type: 'string' },
            datetime: { type: 'string', description: 'Requested appointment time (ISO format)' },
          },
          required: ['cartId', 'serviceId', 'datetime'],
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
