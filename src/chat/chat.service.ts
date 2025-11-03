import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface BookingState {
  locationId?: string | null;
  locationName?: string | null;
  serviceId?: string | null;
  serviceName?: string | null;
  date?: string | null; // YYYY-MM-DD
  time?: string | null; // "06:00 AM"
  bookableTimeId?: string | null;
  staffId?: string | null;
  staffName?: string | null;
  cartId?: string | null;
  // generic extra bag
  [k: string]: any;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private openai!: OpenAI;
  private mcpClient!: Client;
  private readonly model = 'gpt-4o-mini';

  // conversation history (for LLM messages)
  private conversationHistory: Record<string, ChatMsg[]> = {};

  // structured booking state per session
  private sessionState: Record<string, BookingState> = {};

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

    // @ts-ignore
    transport.process?.stdout?.on('data', (d: Buffer) => this.logger.debug(`[MCP STDOUT] ${d.toString().trim()}`));
    // @ts-ignore
    transport.process?.stderr?.on('data', (d: Buffer) => this.logger.error(`[MCP STDERR] ${d.toString().trim()}`));

    this.mcpClient = new Client({ name: 'blvd-mcp-client', version: '1.1.0' });
    await this.mcpClient.connect(transport);
    this.logger.log('✅ Connected to MCP Server');
  }

  // Reset session state and conversation history
  private resetSession(sessionId: string) {
    delete this.conversationHistory[sessionId];
    delete this.sessionState[sessionId];
    // Also remove derived keys stored as conversation keys (if any)
    Object.keys(this.conversationHistory).forEach((k) => {
      if (k.startsWith(sessionId + '_')) delete this.conversationHistory[k];
    });
    this.logger.debug(`Session ${sessionId} reset`);
  }

  // ---------------------
  // JSON Schema for LLM replies
  // ---------------------
  // Must include additionalProperties: false for nested objects (OpenAI requirement)
  private readonly bookingResponseSchema = {
    name: 'BookingAssistantResponse',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'get_locations',
            'choose_location',
            'create_cart',
            'get_services',
            'choose_service',
            'add_service',
            'get_bookable_dates',
            'choose_date',
            'get_bookable_times',
            'choose_time',
            'reserve_slot',
            'get_staff',
            'choose_staff',
            'update_staff',
            'get_summary',
            'confirm_booking',
            'clarify', // ask user to clarify missing info
            'fallback'
          ],
        },
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            locationId: { type: ['string', 'null'] },
            locationName: { type: ['string', 'null'] },
            serviceId: { type: ['string', 'null'] },
            serviceName: { type: ['string', 'null'] },
            date: { type: ['string', 'null'] },
            time: { type: ['string', 'null'] },
            bookableTimeId: { type: ['string', 'null'] },
            staffId: { type: ['string', 'null'] },
            staffName: { type: ['string', 'null'] },
            cartId: { type: ['string', 'null'] },
          },
          required: ['locationId', 'serviceId', 'date', 'time']
        },
        message: { type: 'string' },
      },
      required: ['action', 'message'],
    },
  };

  // ---------------------
  // Public API - main loop
  // ---------------------
  /**
   * Accepts a user message and returns a reply object like:
   * { reply: { role: 'assistant', content: '...' } }
   */
  async getResponse(userMessage: string, sessionId = 'default') {
    const msgTrim = userMessage.trim();
    const msgLower = msgTrim.toLowerCase();

    // Reset if greeting requested
    if (['hi', 'hello', 'hey', 'start', 'restart', 'start over'].includes(msgLower)) {
      this.resetSession(sessionId);
      return this.startFlow(sessionId);
    }

    // Ensure conversation history and state exist
    if (!this.conversationHistory[sessionId]) {
      this.conversationHistory[sessionId] = [
        {
          role: 'system',
          content: this.systemPrompt(),
        },
      ];
    }

    if (!this.sessionState[sessionId]) {
      this.sessionState[sessionId] = {};
    }

    // Push user message to LLM context (so model can reason with chat history)
    this.conversationHistory[sessionId].push({ role: 'user', content: userMessage });

    // Ask the model what to do next (structured)
    let modelResponseRaw: any | undefined;
    try {
      const completion = await this.openai.chat.completions.create(
        {
          model: this.model,
          messages: this.conversationHistory[sessionId],
          response_format: {
            type: 'json_schema',
            json_schema: this.bookingResponseSchema,
          },
          temperature: 0.1,
        },
        { timeout: 60000 },
      );

      modelResponseRaw = completion.choices?.[0]?.message?.content;
      if (!modelResponseRaw) {
        this.logger.error('LLM returned no content');
        return { reply: { role: 'assistant', content: 'Sorry, I had trouble understanding that.' } };
      }
    } catch (err) {
      this.logger.error('LLM json_schema call failed, falling back to plain chat', err);
      // fallback to plain completion to avoid deadlock
      try {
        const plain = await this.openai.chat.completions.create({
          model: this.model,
          messages: this.conversationHistory[sessionId],
        });
        const plainMsg = plain.choices?.[0]?.message;
        this.conversationHistory[sessionId].push(plainMsg);
        return { reply: plainMsg };
      } catch (err2) {
        this.logger.error('Plain fallback also failed', err2);
        return { reply: { role: 'assistant', content: 'An error occurred. Please try again.' } };
      }
    }

    // Store the (stringified) model output in history for debugging
    this.conversationHistory[sessionId].push({ role: 'assistant', content: modelResponseRaw });

    // Parse the model JSON (should conform to schema)
    let modelData: any;
    try {
      modelData = JSON.parse(modelResponseRaw);
    } catch (err) {
      this.logger.error('Failed to parse model JSON', err);
      return { reply: { role: 'assistant', content: 'Sorry — I could not parse the assistant response.' } };
    }

    // Route the action
    try {
      const actionReply = await this.routeAction(modelData, sessionId);
      return actionReply;
    } catch (err) {
      this.logger.error('Routing action failed', err);
      return { reply: { role: 'assistant', content: 'Something went wrong handling your request.' } };
    }
  }

  // ---------------------
  // System prompt that tells the model the rules
  // ---------------------
  private systemPrompt() {
    return `
You are BLVD Booking Assistant — a salon & spa appointment agent.
Your job: infer user intent and return EXACTLY one JSON object (no surrounding text) that matches the provided schema.

You must not invent or assume data. If a user-provided value (like a location name) is given, the system will validate it against real backend data and may ask for correction.
When you decide an action, choose one of:
get_locations, choose_location, create_cart, get_services, choose_service, add_service,
get_bookable_dates, choose_date, get_bookable_times, choose_time, reserve_slot,
get_staff, choose_staff, update_staff, get_summary, confirm_booking, clarify, fallback.

Return JSON:
{
  "action": "<one of the actions>",
  "parameters": { /* only the allowed keys: locationId, locationName, serviceId, serviceName, date, time, bookableTimeId, staffId, staffName, cartId */ },
  "message": "string to present to the user"
}

If required information is missing, use action="clarify" and ask for exactly the missing information.
Never return plain text outside the JSON. Keep message helpful and short.
`;
  }

  // ---------------------
  // Routing LLM action -> MCP/tool handlers
  // ---------------------
  private async routeAction(modelData: any, sessionId: string) {
    const action: string = modelData.action;
    const params: any = modelData.parameters || {};
    const message: string = modelData.message || '';

    switch (action) {
      case 'get_locations':
        return await this.handle_getLocations(sessionId, message);

      case 'choose_location':
        return await this.handle_chooseLocation(sessionId, params, message);

      case 'create_cart':
        return await this.handle_createCart(sessionId, params, message);

      case 'get_services':
        return await this.handle_getServices(sessionId, params, message);

      case 'choose_service':
        return await this.handle_chooseService(sessionId, params, message);

      case 'add_service':
        return await this.handle_addService(sessionId, params, message);

      case 'get_bookable_dates':
        return await this.handle_getBookableDates(sessionId, params, message);

      case 'choose_date':
        return await this.handle_chooseDate(sessionId, params, message);

      case 'get_bookable_times':
        return await this.handle_getBookableTimes(sessionId, params, message);

      case 'choose_time':
        return await this.handle_chooseTime(sessionId, params, message);

      case 'reserve_slot':
        return await this.handle_reserveSlot(sessionId, params, message);

      case 'get_staff':
        return await this.handle_getStaff(sessionId, params, message);

      case 'choose_staff':
        return await this.handle_chooseStaff(sessionId, params, message);

      case 'update_staff':
        return await this.handle_updateStaff(sessionId, params, message);

      case 'get_summary':
        return await this.handle_getSummary(sessionId, params, message);

      case 'confirm_booking':
        return await this.handle_confirmBooking(sessionId, params, message);

      case 'clarify':
        return { reply: { role: 'assistant', content: message } };

      case 'fallback':
      default:
        return { reply: { role: 'assistant', content: message || "I didn't understand — could you rephrase?" } };
    }
  }

  // ---------------------
  // Handlers for actions
  // ---------------------

  // 1) List locations and save to session
  private async handle_getLocations(sessionId: string, message: string) {
    try {
      const result: any = await this.mcpClient.callTool({ name: 'get_locations', arguments: {} });
      const text = result?.content?.[0]?.text || '[]';
      const parsed = JSON.parse(text);
      const locations = Array.isArray(parsed) ? parsed : parsed.locations || [];

      if (!locations.length) {
        return { reply: { role: 'assistant', content: 'No locations are available right now.' } };
      }

      // Save list for validation later
      (this as any).conversationHistory[sessionId + '_locations'] = locations;

      const list = locations.map((l: any, i: number) => `${i + 1}. ${l.name}`).join('\n');
      const reply = message || `Available locations:\n${list}\n\nPlease choose by number or name.`;
      return { reply: { role: 'assistant', content: reply } };
    } catch (err) {
      this.logger.error('get_locations failed', err);
      return { reply: { role: 'assistant', content: 'Failed to fetch locations.' } };
    }
  }

  // 2) Choose location - params may contain locationId or locationName
  private async handle_chooseLocation(sessionId: string, params: any, message: string) {
    // Try to validate provided location against real locations
    let locations = (this as any).conversationHistory[sessionId + '_locations'];
    if (!locations) {
      // fetch if not already fetched
      const res: any = await this.mcpClient.callTool({ name: 'get_locations', arguments: {} });
      const txt = res?.content?.[0]?.text || '[]';
      const parsed = JSON.parse(txt);
      locations = Array.isArray(parsed) ? parsed : parsed.locations || [];
      (this as any).conversationHistory[sessionId + '_locations'] = locations;
    }

    const locId = params.locationId;
    const locName = params.locationName?.toString?.().toLowerCase?.();

    let selected :any = null;
    if (locId) selected = locations.find((l: any) => String(l.id) === String(locId));
    if (!selected && locName) selected = locations.find((l: any) => (l.name || '').toLowerCase() === locName);
    if (!selected && locName) {
      // fuzzy contains
      selected = locations.find((l: any) => (l.name || '').toLowerCase().includes(locName));
    }

    if (!selected) {
      // return list and ask user to pick an exact location
      const list = locations.map((l: any, i: number) => `${i + 1}. ${l.name}`).join('\n');
      const rep = `Sorry, "${params.locationName ?? params.locationId}" is not a valid location. Please choose one of:\n${list}`;
      return { reply: { role: 'assistant', content: rep } };
    }

    // Valid location found — store in session state
    this.sessionState[sessionId] = {
      ...this.sessionState[sessionId],
      locationId: selected.id,
      locationName: selected.name,
    };

    // After selecting location, create cart automatically (or ask model to create)
    // We'll return a friendly message and also create a cart to speed flow
    try {
      const cartResult: any = await this.mcpClient.callTool({
        name: 'createAppointmentCart',
        arguments: { locationId: selected.id },
      });
      const cartText = cartResult?.content?.[0]?.text || '{}';
      const cartData = JSON.parse(cartText || '{}');
      const cartId = cartData?.createCart?.cart?.id || cartData?.cartId;
      if (cartId) {
        this.sessionState[sessionId].cartId = cartId;
      }
    } catch (err) {
      this.logger.error('createAppointmentCart (auto) failed', err);
    }

    const reply = message || `Location set to ${selected.name}. What service would you like?`;
    return { reply: { role: 'assistant', content: reply } };
  }

  // 3) create_cart (explicit)
  private async handle_createCart(sessionId: string, params: any, message: string) {
    try {
      const locationId = params.locationId || this.sessionState[sessionId]?.locationId;
      if (!locationId) return { reply: { role: 'assistant', content: 'Location is required to create a cart.' } };

      const cartResult: any = await this.mcpClient.callTool({
        name: 'createAppointmentCart',
        arguments: { locationId },
      });
      const cartText = cartResult?.content?.[0]?.text || '{}';
      const cartData = JSON.parse(cartText);
      const cartId = cartData?.createCart?.cart?.id || cartData?.cartId;
      if (!cartId) return { reply: { role: 'assistant', content: 'Failed to create cart.' } };

      this.sessionState[sessionId].cartId = cartId;
      return { reply: { role: 'assistant', content: message || 'Cart created.' } };
    } catch (err) {
      this.logger.error('create_cart failed', err);
      return { reply: { role: 'assistant', content: 'Failed to create cart.' } };
    }
  }

  // 4) get_services — fetch available services for session cart/location
  private async handle_getServices(sessionId: string, params: any, message: string) {
    try {
      const cartId = params.cartId || this.sessionState[sessionId]?.cartId;
      if (!cartId) return { reply: { role: 'assistant', content: 'Cart is required to fetch services.' } };

      const svcResult: any = await this.mcpClient.callTool({ name: 'availableServices', arguments: { cartId } });
      const svcText = svcResult?.content?.[0]?.text;
      const svcData = typeof svcText === 'string' ? JSON.parse(svcText) : svcText;

      const excluded = ['Memberships', 'packages', 'products', 'Gift Cards'];
      const services =
        svcData?.cart?.availableCategories
          ?.filter((c: any) => !excluded.includes(c?.name))
          ?.flatMap((c: any) => c?.availableItems || []) || [];

      if (!services.length) return { reply: { role: 'assistant', content: 'No services available at this location.' } };

      // Save list to conversationHistory for rigid selection fallback
      (this as any).conversationHistory[sessionId + '_services'] = services;

      const list = services.map((s: any, i: number) => `${i + 1}. ${s.name}`).join('\n');
      const reply = message || `Available services:\n${list}\n\nPlease choose by number or name.`;
      return { reply: { role: 'assistant', content: reply } };
    } catch (err) {
      this.logger.error('get_services failed', err);
      return { reply: { role: 'assistant', content: 'Failed to fetch services.' } };
    }
  }

  // 5) choose_service - validate user's service selection (by id or name)
  private async handle_chooseService(sessionId: string, params: any, message: string) {
    let services = (this as any).conversationHistory[sessionId + '_services'];
    if (!services) {
      // get services using cartId
      const cartId = this.sessionState[sessionId]?.cartId;
      if (!cartId) return { reply: { role: 'assistant', content: 'No cart available. Please set a location first.' } };
      const srv: any = await this.mcpClient.callTool({ name: 'availableServices', arguments: { cartId } });
      const t = srv?.content?.[0]?.text || '{}';
      const parsed = JSON.parse(t);
      services =
        parsed?.cart?.availableCategories?.flatMap((c: any) => c.availableItems || []) || [];
      (this as any).conversationHistory[sessionId + '_services'] = services;
    }

    const serviceId = params.serviceId;
    const serviceName = params.serviceName?.toString?.().toLowerCase?.();

    let selected :any = null;
    if (serviceId) selected = services.find((s: any) => String(s.id) === String(serviceId));
    if (!selected && serviceName) selected = services.find((s: any) => (s.name || '').toLowerCase() === serviceName);
    if (!selected && serviceName) selected = services.find((s: any) => (s.name || '').toLowerCase().includes(serviceName));

    if (!selected) {
      const list = services.map((s: any, i: number) => `${i + 1}. ${s.name}`).join('\n');
      const rep = `I couldn't match that service. Please choose one of:\n${list}`;
      return { reply: { role: 'assistant', content: rep } };
    }

    // store selected service in session state
    this.sessionState[sessionId] = {
      ...this.sessionState[sessionId],
      serviceId: selected.id,
      serviceName: selected.name,
    };

    // Add to cart (call addServiceToCart)
    try {
      const cartId = this.sessionState[sessionId].cartId!;
      const addRes: any = await this.mcpClient.callTool({ name: 'addServiceToCart', arguments: { cartId, serviceId: selected.id } });
      const addText = addRes?.content?.[0]?.text || '{}';
      const parsedAdd = JSON.parse(addText);
      const selectedServiceId = parsedAdd?.addCartSelectedBookableItem?.cart?.selectedItems?.[0]?.id;
      if (selectedServiceId) {
        this.sessionState[sessionId].selectedServiceId = selectedServiceId;
      }
    } catch (err) {
      this.logger.error('addServiceToCart (during choose_service) failed', err);
      // continue anyway — user can try again
    }

    const reply = message || `Service selected: ${selected.name}. Which date would you prefer?`;
    return { reply: { role: 'assistant', content: reply } };
  }

  // 6) add_service (explicit)
  private async handle_addService(sessionId: string, params: any, message: string) {
    try {
      const cartId = params.cartId || this.sessionState[sessionId]?.cartId;
      const serviceId = params.serviceId || this.sessionState[sessionId]?.serviceId;
      if (!cartId || !serviceId) return { reply: { role: 'assistant', content: 'cartId and serviceId required.' } };

      const res: any = await this.mcpClient.callTool({ name: 'addServiceToCart', arguments: { cartId, serviceId } });
      const text = res?.content?.[0]?.text || '{}';
      const parsed = JSON.parse(text);
      const selectedServiceId = parsed?.addCartSelectedBookableItem?.cart?.selectedItems?.[0]?.id || null;
      if (selectedServiceId) (this.sessionState[sessionId].selectedServiceId = selectedServiceId);

      return { reply: { role: 'assistant', content: message || 'Service added to cart.' } };
    } catch (err) {
      this.logger.error('add_service failed', err);
      return { reply: { role: 'assistant', content: 'Failed to add service.' } };
    }
  }

  // 7) get_bookable_dates
  private async handle_getBookableDates(sessionId: string, params: any, message: string) {
    try {
      const cartId = params.cartId || this.sessionState[sessionId]?.cartId;
      if (!cartId) return { reply: { role: 'assistant', content: 'Cart required to fetch dates.' } };

      const today = new Date();
      const lower = params.searchRangeLower || today.toISOString().split('T')[0];
      const upper = params.searchRangeUpper || new Date(today.getTime() + 14 * 86400000).toISOString().split('T')[0];

      const res: any = await this.mcpClient.callTool({ name: 'cartBookableDates', arguments: { cartId, searchRangeLower: lower, searchRangeUpper: upper } });
      const dates = JSON.parse(res?.content?.[0]?.text || '[]');
      (this as any).conversationHistory[sessionId + '_bookableDates'] = dates;

      if (!Array.isArray(dates) || dates.length === 0) {
        return { reply: { role: 'assistant', content: `No available dates in this range.` } };
      }

      const list = dates.map((d: string, i: number) => `${i + 1}. ${d}`).join('\n');
      return { reply: { role: 'assistant', content: message || `Available dates:\n${list}\n\nPlease choose a date.` } };
    } catch (err) {
      this.logger.error('get_bookable_dates failed', err);
      return { reply: { role: 'assistant', content: 'Failed to fetch bookable dates.' } };
    }
  }

  // 8) choose_date - user picks a date
  private async handle_chooseDate(sessionId: string, params: any, message: string) {
    const date = params.date;
    if (!date) return { reply: { role: 'assistant', content: 'Please provide a date (YYYY-MM-DD).' } };

    // Validate against cached bookableDates if present
    const cachedDates = (this as any).conversationHistory[sessionId + '_bookableDates'] || [];
    if (cachedDates.length && !cachedDates.includes(date)) {
      return { reply: { role: 'assistant', content: `No available slots on ${date}. Please choose one of: ${cachedDates.join(', ')}` } };
    }

    this.sessionState[sessionId] = { ...this.sessionState[sessionId], date };
    const reply = message || `Date set to ${date}. What time would you like?`;
    return { reply: { role: 'assistant', content: reply } };
  }

  // 9) get_bookable_times
  private async handle_getBookableTimes(sessionId: string, params: any, message: string) {
    try {
      const cartId = params.cartId || this.sessionState[sessionId]?.cartId;
      const date = params.date || this.sessionState[sessionId]?.date;
      if (!cartId || !date) return { reply: { role: 'assistant', content: 'Cart and date are required to fetch times.' } };

      const res: any = await this.mcpClient.callTool({ name: 'cartBookableTimes', arguments: { cartId, searchDate: date } });
      const slots = JSON.parse(res?.content?.[0]?.text || '[]');
      (this as any).conversationHistory[sessionId + '_bookableTimes'] = slots;

      if (!Array.isArray(slots) || slots.length === 0) {
        return { reply: { role: 'assistant', content: `No available times on ${date}.` } };
      }

      const list = slots
        .map((t: any, i: number) => `${i + 1}. ${new Date(t.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
        .join('\n');

      return { reply: { role: 'assistant', content: message || `Available times for ${date}:\n${list}\n\nPlease choose a time.` } };
    } catch (err) {
      this.logger.error('get_bookable_times failed', err);
      return { reply: { role: 'assistant', content: 'Failed to fetch available times.' } };
    }
  }

  // 10) choose_time - tries to match by index, time text, or bookableTimeId
  private async handle_chooseTime(sessionId: string, params: any, message: string) {
    const slots = (this as any).conversationHistory[sessionId + '_bookableTimes'] || [];
    let chosen :any = null;
    if (params.bookableTimeId) {
      chosen = slots.find((s: any) => s.id === params.bookableTimeId);
    }
    if (!chosen && params.time) {
      // try to find slot with matching time string
      const normalized = params.time.toString().toLowerCase();
      chosen = slots.find((s: any) => new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase().includes(normalized));
    }
    if (!chosen && params.time && !slots.length) {
      // if no cached slots, allow direct store of date/time (we'll attempt to fetch later)
      this.sessionState[sessionId] = { ...this.sessionState[sessionId], time: params.time };
      return { reply: { role: 'assistant', content: message || `Time set to ${params.time}.` } };
    }
    if (!chosen && params.time && slots.length) {
      // fallback: try parsing hours minutes loosely
      const parsedMatch = this.fuzzyFindSlotByTime(slots, params.time);
      if (parsedMatch) chosen = parsedMatch;
    }
    if (!chosen && params.index) {
      chosen = slots[params.index - 1];
    }

    if (!chosen) {
      return { reply: { role: 'assistant', content: `Could not find a matching time slot. Please choose from the listed times.` } };
    }

    // store selected time and bookableTimeId
    this.sessionState[sessionId] = {
      ...this.sessionState[sessionId],
      time: new Date(chosen.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      bookableTimeId: chosen.id,
    };

    const reply = message || `You selected ${new Date(chosen.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. I will reserve it now.`;
    return { reply: { role: 'assistant', content: reply } };
  }

  // helper: fuzzy find slot
  private fuzzyFindSlotByTime(slots: any[], timeStr: string) {
    const match = timeStr.match(/(\d+):?(\d+)?\s*(am|pm)?/i);
    if (!match) return null;
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || '0', 10);
    const mer = match[3]?.toLowerCase();
    if (mer === 'pm' && hours < 12) hours += 12;
    if (mer === 'am' && hours === 12) hours = 0;

    return slots.find((slot) => {
      const d = new Date(slot.startTime);
      return d.getHours() === hours && Math.abs(d.getMinutes() - minutes) <= 30;
    }) || null;
  }

  // 11) reserve_slot (call reserveCartBookableItems)
  private async handle_reserveSlot(sessionId: string, params: any, message: string) {
    try {
      const cartId = params.cartId || this.sessionState[sessionId]?.cartId;
      const bookableTimeId = params.bookableTimeId || this.sessionState[sessionId]?.bookableTimeId;
      if (!cartId || !bookableTimeId) return { reply: { role: 'assistant', content: 'cartId and bookableTimeId are required to reserve a slot.' } };

      await this.mcpClient.callTool({ name: 'reserveCartBookableItems', arguments: { cartId, bookableTimeId } });
      // note: reserve call may still require staff selection afterward
      return { reply: { role: 'assistant', content: message || 'Slot reserved. Fetching available staff...' } };
    } catch (err) {
      this.logger.error('reserve_slot failed', err);
      return { reply: { role: 'assistant', content: 'Failed to reserve the selected slot.' } };
    }
  }

  // 12) get_staff — fetch staff variants for the reserved slot
  private async handle_getStaff(sessionId: string, params: any, message: string) {
    try {
      const cartId = params.cartId || this.sessionState[sessionId]?.cartId;
      const itemId = params.serviceId || this.sessionState[sessionId]?.selectedServiceId || this.sessionState[sessionId]?.serviceId;
      const bookableTimeId = params.bookableTimeId || this.sessionState[sessionId]?.bookableTimeId;

      if (!cartId || !itemId || !bookableTimeId) return { reply: { role: 'assistant', content: 'cartId, itemId and bookableTimeId are required to fetch staff.' } };

      const res: any = await this.mcpClient.callTool({ name: 'cartBookableStaffVariants', arguments: { id: cartId, itemId, bookableTimeId } });
      const text = res?.content?.[0]?.text;
      let staffData: any;
      try {
        staffData = typeof text === 'string' ? JSON.parse(text) : text;
      } catch {
        staffData = [];
      }

      const staffList = Array.isArray(staffData) ? staffData : staffData?.cartBookableStaffVariants || staffData?.bookableStaffVariants || [];
      (this as any).conversationHistory[sessionId + '_staffList'] = staffList;

      if (!staffList.length) return { reply: { role: 'assistant', content: message || 'No estheticians available for that slot.' } };

      const list = staffList.map((s: any, i: number) => `${i + 1}. ${s.staff?.displayName || `${s.staff?.firstName || ''} ${s.staff?.lastName || ''}`.trim()}`).join('\n');
      return { reply: { role: 'assistant', content: message || `Available estheticians:\n${list}\n\nPlease choose one.` } };
    } catch (err) {
      this.logger.error('get_staff failed', err);
      return { reply: { role: 'assistant', content: 'Failed to fetch estheticians.' } };
    }
  }

  // 13) choose_staff - validate and set staff, then update cart
  private async handle_chooseStaff(sessionId: string, params: any, message: string) {
    const staffList = (this as any).conversationHistory[sessionId + '_staffList'] || [];
    const staffId = params.staffId;
    const staffName = params.staffName?.toString?.().toLowerCase?.();

    let selected :any = null;
    if (staffId) selected = staffList.find((s: any) => String(s.id) === String(staffId));
    if (!selected && staffName) selected = staffList.find((s: any) => ((s.staff?.displayName || '').toLowerCase().includes(staffName) || `${s.staff?.firstName || ''} ${s.staff?.lastName || ''}`.toLowerCase().includes(staffName)));

    if (!selected) {
      const list = staffList.map((s: any, i: number) => `${i + 1}. ${s.staff?.displayName || `${s.staff?.firstName || ''} ${s.staff?.lastName || ''}`.trim()}`).join('\n');
      return { reply: { role: 'assistant', content: `I couldn't match that esthetician. Choose one:\n${list}` } };
    }

    // Update cart with selected staff
    try {
      const cartId = this.sessionState[sessionId]?.cartId;
      const selectedServiceId = this.sessionState[sessionId]?.selectedServiceId || this.sessionState[sessionId]?.serviceId;
      await this.mcpClient.callTool({ name: 'updateCartSelectedBookableItem', arguments: { cartId, itemId: selectedServiceId, staffVariantId: selected.id } });
      this.sessionState[sessionId].staffId = selected.id;
      this.sessionState[sessionId].staffName = selected.staff?.displayName || `${selected.staff?.firstName || ''} ${selected.staff?.lastName || ''}`.trim();

      return { reply: { role: 'assistant', content: message || `Assigned ${this.sessionState[sessionId].staffName} to your booking.` } };
    } catch (err) {
      this.logger.error('choose_staff/updateCartSelectedBookableItem failed', err);
      return { reply: { role: 'assistant', content: 'Failed to assign esthetician.' } };
    }
  }

  // 14) update_staff (explicit)
  private async handle_updateStaff(sessionId: string, params: any, message: string) {
    // Same as choose_staff but expects explicit staffId param
    return this.handle_chooseStaff(sessionId, params, message);
  }

  // 15) get_summary
  private async handle_getSummary(sessionId: string, params: any, message: string) {
    try {
      const cartId = params.cartId || this.sessionState[sessionId]?.cartId;
      if (!cartId) return { reply: { role: 'assistant', content: 'Cart id required to show summary.' } };

      const res: any = await this.mcpClient.callTool({ name: 'getCartSummary', arguments: { cartId } });
      const text = res?.content?.[0]?.text || '{}';
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }

      const summary = parsed?.cart?.summary || parsed?.summary || parsed;
      if (summary && summary.total != null) {
        const subtotal = (summary.subtotal / 100).toFixed(2);
        const tax = (summary.taxAmount / 100).toFixed(2);
        const total = (summary.total / 100).toFixed(2);
        (this as any).conversationHistory[sessionId + '_summary'] = summary;
        const reply = message || `Summary:\nSubtotal: $${subtotal}\nTax: $${tax}\nTotal: $${total}\n\nType 'confirm' to finalize.`;
        return { reply: { role: 'assistant', content: reply } };
      }

      return { reply: { role: 'assistant', content: message || 'Cart summary not available.' } };
    } catch (err) {
      this.logger.error('get_summary failed', err);
      return { reply: { role: 'assistant', content: 'Failed to fetch summary.' } };
    }
  }

  // 16) confirm_booking - here we either call a confirm tool or ask user to confirm
  private async handle_confirmBooking(sessionId: string, params: any, message: string) {
    // Boulevard MCP might not have a single "confirmCart" tool — if it does, call it here.
    // For now, mark pending confirm and return a confirmation prompt.
    const cartId = params.cartId || this.sessionState[sessionId]?.cartId;
    if (!cartId) return { reply: { role: 'assistant', content: 'No active cart to confirm.' } };

    // Save pending confirmation so future 'yes' input can finish booking
    (this as any).conversationHistory[sessionId + '_pendingConfirm'] = { cartId, params };

    const summary = (this as any).conversationHistory[sessionId + '_summary'];
    const totalStr = summary ? `Total: $${(summary.total/100).toFixed(2)}` : '';
    const reply = message || `Your appointment is ready. Type 'yes' to confirm or 'no' to cancel. ${totalStr}`;
    return { reply: { role: 'assistant', content: reply } };
  }

  // ---------------------
  // Helper: start flow (show locations)
  // ---------------------
  private async startFlow(sessionId: string) {
    try {
      const res: any = await this.mcpClient.callTool({ name: 'get_locations', arguments: {} });
      const text = res?.content?.[0]?.text || '[]';
      const parsed = JSON.parse(text);
      const locations = Array.isArray(parsed) ? parsed : parsed.locations || [];

      if (!locations.length) return { reply: { role: 'assistant', content: 'No locations available right now.' } };

      (this as any).conversationHistory[sessionId + '_locations'] = locations;
      const list = locations.map((l: any, i: number) => `${i + 1}. ${l.name}`).join('\n');
      const reply = `Hi! Where would you like to book?\n\n${list}\n\nPlease choose a number or name, or tell me what you want (e.g., "facial Nov 5 6pm at Sandbox").`;

      // initialize conversation history with system + assistant message
      this.conversationHistory[sessionId] = [
        { role: 'system', content: this.systemPrompt() },
        { role: 'assistant', content: reply },
      ];
      this.sessionState[sessionId] = {};

      return { reply: { role: 'assistant', content: reply } };
    } catch (err) {
      this.logger.error('startFlow get_locations failed', err);
      return { reply: { role: 'assistant', content: 'Failed to fetch locations.' } };
    }
  }
}

