import { Injectable, Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

@Injectable()
export class BookingFlowService {
  private readonly logger = new Logger(BookingFlowService.name);
  private sessionState: Record<string, any> = {};

  constructor(private readonly mcpClient: Client) {}

  async handleBooking(userId: string, userInput: any) {
    let state = this.sessionState[userId] || {};
    let responseText = '';

    try {
      // STEP 1️⃣: LOCATION
      if (!state.locationId) {
        const location = await this.validateLocation(userInput.location);
        if (!location.valid) {
          return this.reply(userId, state, `📍 Please choose a location:\n${location.options.join('\n')}`);
        }
        state.locationId = location.id;
        state.locationName = location.name;

        // Create cart
        const cart = await this.createCart(location.id);
        state.cartId = cart.id;
        this.logger.log(`🛒 Cart created: ${cart.id}`);
      }

      // STEP 2️⃣: SERVICE
      if (!state.serviceId) {
        const service = await this.validateService(state.cartId, userInput.service);
        if (!service.valid) {
          return this.reply(userId, state, `💆 Available services:\n${service.options.join('\n')}`);
        }
        state.serviceId = service.id;
        state.serviceName = service.name;
      }

      // STEP 3️⃣: DATE
      if (!state.date) {
        const date = await this.validateDate(state.cartId, state.serviceId, userInput.date);
        if (!date.valid) {
          return this.reply(userId, state, `📅 Available dates:\n${date.options.join(', ')}`);
        }
        state.date = date.value;
      }

      // STEP 4️⃣: TIME
      if (!state.time) {
        const time = await this.validateTime(state.cartId, state.serviceId, state.date, userInput.time);
        if (!time.valid) {
          return this.reply(userId, state, `⏰ Available times for ${state.date}:\n${time.options.join(', ')}`);
        }
        state.time = time.value;
      }

      // STEP 5️⃣: SUMMARY
      responseText = `✅ Booking Summary:
- Location: ${state.locationName}
- Service: ${state.serviceName}
- Date: ${state.date}
- Time: ${state.time}

Would you like to confirm? (yes/no)`;

      return this.reply(userId, state, responseText);
    } catch (err) {
      this.logger.error('Booking flow error', err);
      return { text: '❌ Something went wrong during booking. Please try again later.' };
    }
  }

  private reply(userId: string, state: any, text: string) {
    this.sessionState[userId] = state;
    return { text, state };
  }

  // --------------------------
  // 🧩 Helper MCP methods
  // --------------------------

  async validateLocation(locationName?: string) {
    const result = await this.mcpClient.callTool({ name: 'getLocations', arguments: {} });
    const text = result?.content?.[0]?.text;
    const locations = typeof text === 'string' ? JSON.parse(text) : text;

    if (!locationName) {
      return { valid: false, options: locations.map((l) => l.name) };
    }

    const match = locations.find((l) =>
      l.name.toLowerCase().includes(locationName.toLowerCase())
    );

    if (!match) {
      return { valid: false, options: locations.map((l) => l.name) };
    }

    return { valid: true, id: match.id, name: match.name };
  }

  async createCart(locationId: string) {
    const result = await this.mcpClient.callTool({
      name: 'createCart',
      arguments: { locationId },
    });

    const text = result?.content?.[0]?.text;
    const cart = typeof text === 'string' ? JSON.parse(text) : text;
    return cart;
  }

  async validateService(cartId: string, serviceName?: string) {
    const result = await this.mcpClient.callTool({
      name: 'availableServices',
      arguments: { cartId },
    });

    const text = result?.content?.[0]?.text;
    const services = typeof text === 'string' ? JSON.parse(text) : text;

    if (!serviceName) {
      return { valid: false, options: services.map((s) => s.name) };
    }

    const match = services.find((s) =>
      s.name.toLowerCase().includes(serviceName.toLowerCase())
    );

    if (!match) {
      return { valid: false, options: services.map((s) => s.name) };
    }

    return { valid: true, id: match.id, name: match.name };
  }

  async validateDate(cartId: string, serviceId: string, date?: string) {
    const result = await this.mcpClient.callTool({
      name: 'cartBookableDates',
      arguments: { cartId, serviceId },
    });

    const text = result?.content?.[0]?.text;
    const dates = typeof text === 'string' ? JSON.parse(text) : text;

    if (!date) {
      return { valid: false, options: dates };
    }

    const normalized = this.normalizeDate(date);
    const exists = dates.includes(normalized);
    return exists
      ? { valid: true, value: normalized }
      : { valid: false, options: dates };
  }

  async validateTime(cartId: string, serviceId: string, date: string, time?: string) {
    const result = await this.mcpClient.callTool({
      name: 'cartBookableTimes',
      arguments: { cartId, serviceId, date },
    });

    const text = result?.content?.[0]?.text;
    const times = typeof text === 'string' ? JSON.parse(text) : text;

    if (!time) {
      return { valid: false, options: times };
    }

    const normalized = this.normalizeTime(time);
    const exists = times.some((t) => t.startsWith(normalized));
    return exists
      ? { valid: true, value: normalized }
      : { valid: false, options: times };
  }

  // --------------------------
  // 🕐 Utility Formatters
  // --------------------------
  private normalizeDate(dateStr: string) {
    // Converts “6 nov 2025” → “2025-11-06”
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  }

  private normalizeTime(timeStr: string) {
    // Converts “6 am” → “06:00”
    const [num, ampm] = timeStr.toLowerCase().split(' ');
    let hour = parseInt(num);
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return hour.toString().padStart(2, '0') + ':00';
  }
}
