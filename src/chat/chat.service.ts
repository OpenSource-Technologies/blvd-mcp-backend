import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * BookingState keeps both machine IDs and friendly names so the assistant can reply naturally.
 */
interface BookingState {
  locationId?: string;
  locationName?: string;

  cartId?: string;

  serviceId?: string;      // the actual service item id (catalog id)
  serviceName?: string;    // friendly name (e.g. "Facial (30min)")

  itemId?: string;         // top-level selectedItems[].id (cart item id)
  itemName?: string;

  bookableTimeId?: string; // reserved time id
  timeLabel?: string;      // friendly time (e.g. "10:30 AM")
  date?: string;           // YYYY-MM-DD or friendly human string

  staffVariantId?: string;
  staffName?: string;

  promotionOfferId?: string;

  lastTool?: string;
}

@Injectable()
export class ChatService {
  private openai: OpenAI;
  private mcpClient: Client;
  private stateStore: Record<string, BookingState> = {};

  constructor() {
    this.initialize();
  }

  private async initialize() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const transport = new StdioClientTransport({
      command: 'node',
      args: ['dist/appointment-booking.js'],
      stderr: 'inherit',
    });

    // optional logging from the MCP process
    // @ts-ignore
    transport.process?.stdout?.on('data', (d: Buffer) => console.log('[MCP STDOUT]', d.toString().trim()));
    // @ts-ignore
    transport.process?.stderr?.on('data', (d: Buffer) => console.error('[MCP STDERR]', d.toString().trim()));

    this.mcpClient = new Client({
      name: 'blvd-mcp-client',
      version: '1.1.0',
    });

    await this.mcpClient.connect(transport);
    console.log('✅ MCP client connected');
  }

  /**
   * All MCP tool definitions (use exactly your list).
   */
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
            properties: { locationId: { type: 'string' } },
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
            properties: { cartId: { type: 'string' } },
            required: ['cartId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'applyPromotionCode',
          description: 'Applies a promo or discount code to the user’s active cart to adjust pricing before checkout.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              offerCode: { type: 'string' },
            },
            required: ['cartId', 'offerCode'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'removeCartOffer',
          description: 'Removes an applied promotion or discount offer from the user’s cart.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              offerId: { type: 'string' },
            },
            required: ['cartId', 'offerId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'addServiceToCart',
          description: 'Adds a chosen service to the cart. Requires cartId and serviceId.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              serviceId: { type: 'string' },
            },
            required: ['cartId', 'serviceId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'removeItemInCart',
          description: 'Removes a selected service from the user’s cart.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              itemId: { type: 'string' },
            },
            required: ['cartId', 'itemId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cartBookableDates',
          description: 'Fetches available booking dates for the selected service in the cart.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              searchRangeLower: { type: 'string' },
              searchRangeUpper: { type: 'string' },
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
              searchDate: { type: 'string' },
            },
            required: ['cartId', 'searchDate'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'reserveCartBookableItems',
          description: 'Reserves/confirms the chosen time slot and staff assignment. Requires cartId and bookableTimeId.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              bookableTimeId: { type: 'string' },
            },
            required: ['cartId', 'bookableTimeId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cartBookableStaffVariants',
          description: 'Fetches available staff for the reserved service/time slot.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              itemId: { type: 'string' },
              bookableTimeId: { type: 'string' },
            },
            required: ['cartId', 'itemId', 'bookableTimeId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'updateCartSelectedBookableItem',
          description: 'Assigns a staff member to the reserved service. Requires cartId, itemId, staffVariantId.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string' },
              itemId: { type: 'string' },
              staffVariantId: { type: 'string' },
            },
            required: ['cartId', 'itemId', 'staffVariantId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'setClientOnCart',
          description: 'Attaches client information (firstName,lastName,email,phoneNumber).',
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
      },
      {
        type: 'function',
        function: {
          name: 'addCartCardPaymentMethod',
          description: 'Attaches a tokenized card payment method to an existing Blvd cart.',
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
      },
      {
        type: 'function',
        function: {
          name: 'checkoutCart',
          description: 'Performs the final checkout for a Boulevard cart. Requires the full cartId.',
          parameters: {
            type: 'object',
            properties: { cartId: { type: 'string' } },
            required: ['cartId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'getCartSummary',
          description: 'Retrieves the final summary and total price of the cart.',
          parameters: {
            type: 'object',
            properties: { cartId: { type: 'string' } },
            required: ['cartId'],
          },
        },
      },
    ];
  }

  /**
   * Build human readable state summary (not long — short and explicit).
   */
  private buildHumanReadableState(state: BookingState) {
    if (!state || Object.keys(state).length === 0) return 'No booking in progress.';
    const parts: string[] = [];
    if (state.locationName) parts.push(`Location: ${state.locationName}`);
    if (state.serviceName) parts.push(`Service: ${state.serviceName}`);
    if (state.itemName) parts.push(`Cart Item: ${state.itemName}`);
    if (state.date || state.timeLabel) {
      const dt = [state.date, state.timeLabel].filter(Boolean).join(' ');
      if (dt) parts.push(`When: ${dt}`);
    }
    if (state.staffName) parts.push(`Staff: ${state.staffName}`);
    if (state.cartId) parts.push(`Cart ID: ${state.cartId}`);
    return parts.join(' • ') || 'No booking in progress.';
  }

  /**
   * Main entry point. Single-shot reasoning (no long convo). If model requests tools,
   * we execute them sequentially and persist state-friendly names for natural replies.
   */
  async getResponse(userText: string, sessionId = 'default'): Promise<any> {
    // ensure state exists
    if (!this.stateStore[sessionId]) this.stateStore[sessionId] = {};

    const state = this.stateStore[sessionId];

    const systemPrompt = `
You are a friendly appointment booking assistant for salons/spas.
You should parse user's intent (location, service, date, time, promo) and call the provided tools as needed.
Prefer single-turn resolution when user provided full details.
If details are missing, ask succinct clarifying questions.
Use the provided "Current booking" summary to reason — do NOT require full chat history.
When replying to the user, be natural and concise.
`;

    const humanState = this.buildHumanReadableState(state);

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: `Current booking: ${humanState}` },
      { role: 'user', content: userText },
    ];

    // single LLM call that may return tool_calls
    let completion;
    try {
      completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools: this.getBookingTools(),
        tool_choice: 'auto',
        temperature: 0.1,
        // you can tune max_tokens if desired
      });
    } catch (err: any) {
      console.error('OpenAI call error', err);
      return {
        reply: {
          role: 'assistant',
          content: 'Sorry — I had a problem contacting the assistant. Please try again.',
          refusal: null,
          annotations: [],
        },
      };
    }

    const aiMessage = completion.choices[0].message;

    // If LLM decides to call one or multiple tools, execute them sequentially.
    if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
      const executedResults: any[] = [];

      for (const toolCall of aiMessage.tool_calls) {
        // skip non-function types
        if (toolCall.type !== 'function') continue;

        const funcName = toolCall.function.name;
        let funcArgs: any = {};
        try {
          funcArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch {
          funcArgs = {};
        }

        try {
          // Call the MCP tool via client (use the same calling convention your MCP expects).
          const result: any = await this.mcpClient.callTool({
            name: funcName,
            arguments: funcArgs,
          });

          executedResults.push({ tool: funcName, result });

          // parse tool result and update friendly state
          this.updateStateFromTool(sessionId, funcName, result);

          // Special mandated flows: if reserveCartBookableItems was called — ask promo question per your rules
          if (funcName === 'reserveCartBookableItems') {
            // Immediately ask about promotion codes (per your business rule)
            const prompt = 'Great! That time slot is reserved. Do you have a promotion code you would like to apply to this booking?';
            return {
              reply: {
                role: 'assistant',
                content: prompt,
                refusal: null,
                annotations: [],
              },
            };
          }

          // After applying promo or removing one, refresh summary is usually required by your rules,
          // but we leave the assistant to call getCartSummary if needed.

        } catch (err: any) {
          console.error(`Tool ${funcName} failed:`, err?.message || err);
          return {
            reply: {
              role: 'assistant',
              content: `I attempted to run ${funcName} but it failed: ${err?.message || 'unknown error'}. Please try again or contact support.`,
              refusal: null,
              annotations: [],
            },
          };
        }
      }

      // After executing tool chain, return a concise success message + executed results (if helpful)
      const newState = this.stateStore[sessionId];
      const friendly = this.buildHumanReadableState(newState);

      return {
        reply: {
          role: 'assistant',
          content: `Done. ${friendly}`,
          refusal: null,
          annotations: [],
        },
      };
    }

    // If no tool_calls, respond with the model's text content (it could be a question or direct reply)
    const textReply = aiMessage.content || 'Okay — what would you like to do next?';

    return {
      reply: {
        role: 'assistant',
        content: textReply,
        refusal: null,
        annotations: [],
      },
    };
  }

  /**
   * Update friendly state after receiving raw tool output from MCP.
   * The tool's result object shape varies; this function tries common patterns robustly.
   */
  private updateStateFromTool(sessionId: string, toolName: string, rawResult: any) {
    if (!this.stateStore[sessionId]) this.stateStore[sessionId] = {};
    const state = this.stateStore[sessionId];

    // helper to safely parse result.content[0].text when present
    const parseToolText = (res: any) => {
      try {
        const txt = res?.content?.[0]?.text;
        if (typeof txt === 'string') return JSON.parse(txt);
      } catch {}
      return res;
    };

    const data = parseToolText(rawResult);

    // Common extraction patterns — adjust if your MCP returns different shapes.
    switch (toolName) {
      case 'getLocations': {
        // data might be an array of locations
        if (Array.isArray(data) && data.length > 0) {
          // do not auto-select - just save first id as available reference only if state is empty
          if (!state.locationId) {
            state.locationId = data[0].id || state.locationId;
            state.locationName = data[0].name || state.locationName;
          }
        }
        break;
      }
      case 'createAppointmentCart': {
        // common shapes: { createCart: { cart: { id: 'urn:...' } } } or { cartId: '...' }
        const cartId =
          data?.createCart?.cart?.id ||
          data?.cart?.id ||
          data?.cartId ||
          data?.id;
        if (cartId) state.cartId = cartId;
        break;
      }
      case 'availableServices': {
        // might return list of services — we don't auto-add, but can capture first as reference
        if (Array.isArray(data) && data.length > 0) {
          if (!state.serviceId) {
            state.serviceId = data[0].id || state.serviceId;
            state.serviceName = data[0].name || state.serviceName;
          }
        }
        // also some APIs return { services: [...] }
        if (data?.services && Array.isArray(data.services) && data.services.length > 0) {
          if (!state.serviceId) {
            state.serviceId = data.services[0].id || state.serviceId;
            state.serviceName = data.services[0].name || state.serviceName;
          }
        }
        break;
      }
      case 'addServiceToCart': {
        // result often contains cart.selectedItems[0]
        const item = data?.addServiceToCart?.cart?.selectedItems?.[0] || data?.selectedItems?.[0] || data?.item || data;
        if (item) {
          state.itemId = item.id || state.itemId;
          state.itemName = item.name || item.item?.name || state.itemName;
          // record underlying catalog service id if present
          if (item.item && item.item.id) state.serviceId = item.item.id;
          if (!state.serviceName && item.item?.name) state.serviceName = item.item.name;
        }
        break;
      }
      case 'cartBookableDates': {
        // might return available dates; we do not auto-select
        break;
      }
      case 'cartBookableTimes': {
        // could capture time labels if provided
        if (Array.isArray(data) && data.length > 0) {
          if (!state.bookableTimeId) {
            const first = data[0];
            state.bookableTimeId = first.id || state.bookableTimeId;
            if (first.label) state.timeLabel = first.label;
            if (first.startTime) {
              const d = new Date(first.startTime);
              state.date = d.toISOString().split('T')[0];
              state.timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            }
          }
        }
        break;
      }
      case 'reserveCartBookableItems': {
        // reservation success often returns selectedBookableItem or cart.startTime
        const sb = data?.reserveCartBookableItems?.cart?.selectedBookableItem || data?.selectedBookableItem || data;
        if (sb) {
          state.bookableTimeId = sb.id || state.bookableTimeId;
          if (sb.startTime) {
            const d = new Date(sb.startTime);
            state.date = d.toISOString().split('T')[0];
            state.timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          } else if (sb.label) {
            state.timeLabel = sb.label;
          }
        }
        // sometimes cart.startTime present
        if (data?.cart?.startTime) {
          const d = new Date(data.cart.startTime);
          state.date = d.toISOString().split('T')[0];
          state.timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        }
        break;
      }
      case 'cartBookableStaffVariants': {
        // data may be list of staff variants; we do not auto-select staff but we can save first
        if (Array.isArray(data) && data.length > 0) {
          if (!state.staffVariantId) {
            state.staffVariantId = data[0].id || state.staffVariantId;
            state.staffName = data[0].displayName || data[0].name || state.staffName;
          }
        }
        break;
      }
      case 'updateCartSelectedBookableItem': {
        // after assigning staff, reservation must be re-called — capture staff
        const sel = data?.updateCart?.cart?.selectedItems?.[0] || data;
        if (sel && sel.staffVariantId) state.staffVariantId = sel.staffVariantId;
        if (sel && sel.selectedStaffVariant?.staff?.displayName) state.staffName = sel.selectedStaffVariant.staff.displayName;
        break;
      }
      case 'applyPromotionCode': {
        const offerId = data?.applyPromotionCode?.offer?.id || data?.offerId || data?.id;
        if (offerId) state.promotionOfferId = offerId;
        break;
      }
      case 'getCartSummary': {
        // Use cart summary to fill friendly names if present
        const cart = data?.getCartSummary?.cart || data?.cart || data;
        if (cart) {
          if (cart.location?.name) state.locationName = cart.location.name;
          if (cart.clientInformation?.email) { /* we do not store personal info unless required */ }
          if (cart.selectedItems?.length) {
            const it = cart.selectedItems[0];
            state.itemId = it.id || state.itemId;
            state.itemName = it.item?.name || it.name || state.itemName;
            if (it.selectedStaffVariant?.staff?.displayName) state.staffName = it.selectedStaffVariant.staff.displayName;
          }
          if (cart.startTime) {
            const d = new Date(cart.startTime);
            state.date = d.toISOString().split('T')[0];
            state.timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          }
        }
        break;
      }
      default:
        break;
    }

    state.lastTool = toolName;
    this.stateStore[sessionId] = state;
  }

  /**
   * Provide a simple helper endpoint to fetch the current friendly booking summary.
   */
  async getFriendlySummary(sessionId = 'default') {
    const state = this.stateStore[sessionId] || {};
    const summary = this.buildHumanReadableState(state);
    return {
      reply: {
        role: 'assistant',
        content: summary,
        refusal: null,
        annotations: [],
      },
    };
  }

  /**
   * setPaymentToken kept for compatibility (you said payments handled by third-party).
   * This function is left in case you later use it to attach token via MCP.
   */
  async setPaymentToken(token: string, sessionId = 'default'): Promise<any> {
    const state = this.stateStore[sessionId];
    if (!state?.cartId) {
      return {
        reply: {
          role: 'assistant',
          content: 'I am sorry — I cannot find an active cart for this session. Please start a booking first.',
          refusal: null,
          annotations: [],
        },
      };
    }

    try {
      await this.mcpClient.callTool({
        name: 'addCartCardPaymentMethod',
        arguments: { cartId: state.cartId, token, select: true },
      });

      return {
        reply: {
          role: 'assistant',
          content: 'Payment method attached successfully (note: final payment is handled externally).',
          refusal: null,
          annotations: [],
        },
      };
    } catch (err: any) {
      console.error('setPaymentToken error', err);
      return {
        reply: {
          role: 'assistant',
          content: `Failed to attach payment method: ${err?.message || 'unknown error'}`,
          refusal: null,
          annotations: [],
        },
      };
    }
  }
}
