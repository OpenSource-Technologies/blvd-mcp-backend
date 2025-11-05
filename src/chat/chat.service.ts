import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

  /**
   * Extract booking intent from user message using GPT
   */
  private async extractBookingIntent(userMessage: string): Promise<BookingIntent> {
    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an intent extraction assistant. Extract booking details from user messages.
          Return ONLY a JSON object with these optional fields: service, location, date, time, esthetician.
          If a field is not mentioned, omit it or set to null.
          
          Examples:
          - "I want to book classic haircut at 6am on 12 nov 2025" → {"service": "classic haircut", "date": "2025-11-12", "time": "06:00"}
          - "book at first sandbox location" → {"location": "first sandbox"}
          - "haircut tomorrow at 3pm" → {"service": "haircut", "date": "tomorrow", "time": "15:00"}
          
          For dates: Convert to YYYY-MM-DD format if possible, otherwise keep as-is (e.g., "tomorrow", "next monday")
          For times: Convert to 24-hour HH:MM format if possible
          `,
        },
        { role: 'user', content: userMessage },
      ],
      response_format: { type: 'json_object' },
    });

    try {
      console.log("fullIntent >> ",completion.choices[0].message)
      return JSON.parse(completion.choices[0].message.content || '{}');
    } catch {
      return {};
    }
  }

  /**
   * Match user input against available options (fuzzy matching)
   */
  private findBestMatch(userInput: string, options: any[], nameField: string = 'name'): any {
    const input = userInput.toLowerCase().trim();
    
    // Try exact match first
    let match = options.find(opt => opt[nameField]?.toLowerCase() === input);
    if (match) return match;

    // Try partial match
    match = options.find(opt => opt[nameField]?.toLowerCase().includes(input));
    if (match) return match;

    // Try reverse partial match (input contains option name)
    match = options.find(opt => input.includes(opt[nameField]?.toLowerCase()));
    return match;
  }

  /**
   * Parse flexible date input
   */
  private parseDate(dateInput: string): string {
    const today = new Date();
    const input = dateInput.toLowerCase();

    if (input === 'today') {
      return today.toISOString().split('T')[0];
    }
    if (input === 'tomorrow') {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      return tomorrow.toISOString().split('T')[0];
    }
    
    // Try parsing as ISO date
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
      return dateInput;
    }

    // Try parsing natural date
    try {
      const parsed = new Date(dateInput);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().split('T')[0];
      }
    } catch {}

    return dateInput;
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
      this.conversationHistory[sessionId] = [
        {
          role: 'system',
          content: `You are BLVD Appointment Booking Assistant. Help users book appointments naturally and flexibly.
          
          WORKFLOW:
          1. Always fetch locations first (mandatory)
          2. Match or ask for location
          3. Create cart with location
          4. Match or ask for service
          5. Add service to cart
          6. Match or ask for date
          7. Match or ask for time
          8. Reserve time slot
          9. Match or ask for esthetician
          10. Show summary and confirm
          
          RULES:
          - Always validate user input against real data from MCP tools
          - If user provides info upfront, validate and auto-proceed when possible
          - If info is invalid or not found, show available options
          - Keep responses concise and helpful
          - Never skip the getLocations step
          - Never use fake or placeholder data
          `,
        },
      ];
    }

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
    
    if (!locations) {
      try {
        const result: any = await this.mcpClient.callTool({
          name: 'get_locations',
          arguments: {},
        });

        const text = result?.content?.[0]?.text || '[]';
        const parsed = JSON.parse(text);
        locations = Array.isArray(parsed) ? parsed : parsed.locations || [];
        (this as any).conversationHistory[sessionId + '_locations'] = locations;

        if (!locations.length) {
          return { reply: { role: 'assistant', content: 'Sorry, no locations are available at the moment.' } };
        }
      } catch (err) {
        console.error('❌ getLocations failed:', err);
        return { reply: { role: 'assistant', content: 'Failed to fetch locations. Please try again.' } };
      }
    }

    // ========================================
    // STEP 2: Handle location selection
    // ========================================
    let selectedLocation = (this as any).conversationHistory[sessionId + '_selectedLocation'];

    if (!selectedLocation) {
      // Check if user provided location in their message
      if (mergedIntent.location) {
        const match = this.findBestMatch(mergedIntent.location, locations, 'name');
        if (match) {
          selectedLocation = match;
          (this as any).conversationHistory[sessionId + '_selectedLocation'] = selectedLocation;
          delete (this as any).conversationHistory[sessionId + '_locations'];
          console.log('✅ Auto-matched location:', selectedLocation.name);
        } else {
          // Location mentioned but not found
          const list = locations.map((l: any, i: number) => `${i + 1}. ${l.name}`).join('\n');
          return {
            reply: {
              role: 'assistant',
              content: `I couldn't find "${intent.location}". Here are the available locations:\n${list}\n\nPlease choose one by typing the number or name.`,
            },
          };
        }
      } else {
        // No location mentioned, show options
        const list = locations.map((l: any, i: number) => `${i + 1}. ${l.name}`).join('\n');
        return {
          reply: {
            role: 'assistant',
            content: `Hello! Here are our available locations:\n${list}\n\nPlease choose one by typing the number or name.`,
          },
        };
      }
    }

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
            const result = await this.mcpClient.callTool({
              name: 'addServiceToCart',
              arguments: { cartId, serviceId: selectedService.id },
            });

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
            console.log('✅ Time slot reserved');
            
            // Don't return here - continue to staff selection below
          } catch (err) {
            console.error('❌ reserveCartBookableItems failed:', err);
            return { reply: { role: 'assistant', content: 'Failed to reserve time slot. Please try again.' } };
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

          let staffText = staffResult?.content?.[0]?.text;
          let staffData: any;
          try {
            staffData = typeof staffText === 'string' ? JSON.parse(staffText) : staffText;
          } catch {
            staffData = [];
          }

          staffList = Array.isArray(staffData)
            ? staffData
            : staffData?.cartBookableStaffVariants || staffData?.bookableStaffVariants || [];

          (this as any).conversationHistory[sessionId + '_staffList'] = staffList;

          if (!staffList.length) {
            return { reply: { role: 'assistant', content: 'No estheticians available for this time slot. Please try another time.' } };
          }
        } catch (err) {
          console.error('❌ cartBookableStaffVariants failed:', err);
          return { reply: { role: 'assistant', content: 'Failed to fetch available estheticians. Please try again.' } };
        }
      }

      // Check if user provided esthetician preference
      if (intent.esthetician) {
        const match = this.findBestMatch(intent.esthetician, staffList, 'displayName') ||
                      staffList.find((s: any) => 
                        `${s.staff?.firstName || ''} ${s.staff?.lastName || ''}`.toLowerCase().includes(intent.esthetician!.toLowerCase())
                      );

        if (match) {
          selectedStaff = match;
          (this as any).conversationHistory[sessionId + '_selectedStaff'] = selectedStaff;
          delete (this as any).conversationHistory[sessionId + '_staffList'];
          console.log('✅ Auto-matched staff:', selectedStaff.staff?.displayName);
          
          // Don't return here - continue to update cart and show summary below
        }
      }

      if (!selectedStaff) {
        // Show staff options
        const list = staffList.map((s: any, i: number) =>
          `${i + 1}. ${s.staff?.displayName || `${s.staff?.firstName || ''} ${s.staff?.lastName || ''}`.trim() || 'Unnamed'}`
        ).join('\n');

        return {
          reply: {
            role: 'assistant',
            content: `Here are the available estheticians:\n${list}\n\nPlease choose one by typing the number or name.`,
          },
        };
      }

      // Update cart with selected staff
      try {
        await this.mcpClient.callTool({
          name: 'updateCartSelectedBookableItem',
          arguments: {
            cartId,
            itemId: selectedServiceId,
            staffVariantId: selectedStaff.id,
          },
        });
        console.log('✅ Staff assigned to cart');
      } catch (err) {
        console.error('❌ updateCartSelectedBookableItem failed:', err);
        return { reply: { role: 'assistant', content: 'Failed to assign esthetician. Please try again.' } };
      }
    }

    // ========================================
    // STEP 8: Show summary and confirm
    // ========================================
    try {
      const summaryResult: any = await this.mcpClient.callTool({
        name: 'getCartSummary',
        arguments: { cartId },
      });

      const summaryText = summaryResult?.content?.[0]?.text || '{}';
      let summaryData: any;
      try {
        summaryData = JSON.parse(summaryText);
      } catch {
        summaryData = {};
      }

      const staffName = selectedStaff.staff?.displayName ||
        `${selectedStaff.staff?.firstName || ''} ${selectedStaff.staff?.lastName || ''}`.trim();

      const time = new Date(selectedTimeSlot.startTime).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });

      let reply = `✅ **Appointment Summary**\n\n`;
      reply += `📍 Location: ${selectedLocation.name}\n`;
      reply += `💆 Service: ${selectedService.name}\n`;
      reply += `📅 Date: ${selectedDate}\n`;
      reply += `🕒 Time: ${time}\n`;
      reply += `👤 Esthetician: ${staffName}\n\n`;

      if (summaryData?.summary) {
        reply += `💰 Subtotal: $${(summaryData.summary.subtotal / 100).toFixed(2)}\n`;
        reply += `💰 Tax: $${(summaryData.summary.taxAmount / 100).toFixed(2)}\n`;
        reply += `💰 **Total: $${(summaryData.summary.total / 100).toFixed(2)}**\n\n`;
      }

      reply += `Would you like to confirm your appointment?`;

      return { reply: { role: 'assistant', content: reply } };
    } catch (err) {
      console.error('❌ getCartSummary failed:', err);
      return { reply: { role: 'assistant', content: 'Failed to fetch cart summary. Please try again.' } };
    }
  }
}