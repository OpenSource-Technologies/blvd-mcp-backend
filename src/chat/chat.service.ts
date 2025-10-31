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

    // capture logs from MCP
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
  async getResponse(userMessage: string, sessionId = 'default') {
    if (!this.conversationHistory[sessionId]) {
      this.conversationHistory[sessionId] = [
        {
          role: 'system',
          content: `
        You are **BLVD Appointment Booking Assistant**, a highly structured and professional virtual assistant for Boulevard salons.
        
        🎯 **Primary Goal:** Help the user book an appointment step-by-step using the Boulevard system.  
        Do **not** skip steps. Always verify required data (like location, service, date, time, and esthetician) in order.
        
        ---
        
        ### 🧭 Booking Workflow (Strictly Follow This Order)
        1️⃣ **Greeting → Location Selection**  
           - When the user says "hi", "hello", "book appointment", etc., greet them and show available locations.  
           - If multiple locations exist, ask them to choose one by typing the number or name.
        
        2️⃣ **After Location → Create Cart & Show Services**  
           - Once a location is selected, create a cart and fetch available services.  
           - Present the services clearly in a numbered list.  
           - Ask: “Please choose one by typing the number or name.”
        
        3️⃣ **After Service → Add to Cart & Show Available Dates**  
           - Once a service is selected, add it to the cart.  
           - Fetch available booking dates (typically 7 days from today).  
           - Display the next available dates with indexes.  
           - Ask: “Please choose a date by typing the number or date.”
        
        4️⃣ **After Date → Show Available Times**  
           - When the user selects a date, show available times for that date.  
           - Format times in human-readable format (e.g., 10:30 AM, 2:45 PM).  
           - Ask: “Please choose a time by typing the number.”
        
        5️⃣ **After Time → Reserve Slot & Show Estheticians**  
           - Reserve the selected slot.  
           - Fetch and display available estheticians (staff members).  
           - Ask: “Please choose an esthetician by typing the number or name.”
        
        6️⃣ **After Esthetician → Confirm and Show Summary**  
           - Update the cart with the selected esthetician.  
           - Fetch the final cart summary.  
           - Display subtotal, tax, and total amount.  
           - Then ask: “Would you like to confirm your appointment now?”
        
        ---
        
        ### 🧠 Rules
        - Always stay within the step-by-step booking flow above.  
        - Never skip to the next step unless the previous one is confirmed.  
        - If the user types something unrelated, respond politely but bring them back to the correct step.  
        - If an error occurs (like no slots or staff found), gracefully ask them to try another option.  
        - Keep messages short, professional, and clear — no emojis except ✅ ❌ 💆 🕓 📅 for visual clarity.  
        - **🚫 Never show fake, assumed, or placeholder data.**  
          - Do not generate or imagine any locations, services, dates, times, or staff.  
          - Always call the correct MCP tools to get real backend data.  
          - If data is missing, clearly say “No data found from Boulevard for this step.” and stop until valid data is returned.  
        - **🧠 Smart Logic Rule:** Use your reasoning to decide which MCP tool to call based on what the user says (e.g., if they ask for services → call availableServices, if they ask for times → call cartBookableTimes).
        
        ---
        
        Example Tone:
        > “Please select one of the following dates by typing the number.”  
        > “That’s not a valid option, could you please choose again?”
        
        You have access to backend tools for real-time data via the MCP server.  
        Your responses should always match the booking flow and only guide users through valid steps.
          `,
        }
        
      ];
    }


    
  
    this.conversationHistory[sessionId].push({ role: 'user', content: userMessage });
  
    // -------------------------------
    // 🏁 STEP 1 — GREETING → Locations
    // -------------------------------
    if (/^(hi|hello|hey|help)/i.test(userMessage.trim())) {
      try {
        const result: any = await this.mcpClient.callTool({
          name: 'get_locations',
          arguments: {},
        });
  
        const text = result?.content?.[0]?.text || '[]';
        const parsed = JSON.parse(text);
        const locations = Array.isArray(parsed) ? parsed : parsed.locations || [];
  
        if (locations.length > 0) {
          const list = locations.map((l: any, i: number) => `${i + 1}. ${l.name}`).join('\n');
          const reply = `Hello! Here are the available locations:\n${list}\n\nPlease choose one by typing the number or name.`;
  
          this.conversationHistory[sessionId].push({ role: 'assistant', content: reply });
          (this as any).conversationHistory[sessionId + '_locations'] = locations;
  
          return { reply: { role: 'assistant', content: reply } };
        } else {
          return { reply: { role: 'assistant', content: 'Sorry, no locations are available.' } };
        }
      } catch (err) {
        console.error('❌ [ChatService] get_locations failed:', err);
        return { reply: { role: 'assistant', content: 'Failed to fetch locations.' } };
      }
    }
  
    // -------------------------------
    // 🏠 STEP 2 — Select Location
    // -------------------------------
    const locations = (this as any).conversationHistory[sessionId + '_locations'];
    const selectedLocation = (this as any).conversationHistory[sessionId + '_selectedLocation'];
  
    if (locations && !selectedLocation) {
      const input = userMessage.trim().toLowerCase();
      const selected =
        locations[parseInt(input) - 1] ||
        locations.find((l: any) => l.name.toLowerCase().includes(input));
  
      if (selected) {
        (this as any).conversationHistory[sessionId + '_selectedLocation'] = selected;
        delete (this as any).conversationHistory[sessionId + '_locations']; // ✅ cleanup
  
        try {
          const cartResult: any = await this.mcpClient.callTool({
            name: 'createAppointmentCart',
            arguments: { locationId: selected.id },
          });
  
          const cartText = cartResult?.content?.[0]?.text;
          const cartData = JSON.parse(cartText || '{}');
          const cartId = cartData?.createCart?.cart?.id || cartData?.cartId;
          if (!cartId) throw new Error('No cartId returned');
  
          (this as any).conversationHistory[sessionId + '_cartId'] = cartId;
  
          const svcResult: any = await this.mcpClient.callTool({
            name: 'availableServices',
            arguments: { cartId },
          });
  
          let svcText = svcResult?.content?.[0]?.text;
          let svcData = typeof svcText === 'string' ? JSON.parse(svcText) : svcText;
          const excluded = ['Memberships', 'packages', 'products', 'Gift Cards'];
  
          const services =
            svcData?.cart?.availableCategories
              ?.filter((c: any) => !excluded.includes(c?.name))
              ?.flatMap((c: any) => c?.availableItems || []) || [];
  
          if (!services.length)
            return { reply: { role: 'assistant', content: `No services available at ${selected.name}.` } };
  
          const list = services.map((s: any, i: number) => `${i + 1}. ${s.name}`).join('\n');
          const reply = `You selected **${selected.name}**.\nHere are the available services:\n${list}\n\nPlease choose one by typing the number or name.`;
  
          (this as any).conversationHistory[sessionId + '_services'] = services;
          return { reply: { role: 'assistant', content: reply } };
        } catch (err) {
          console.error('❌ [ChatService] Cart or services failed:', err);
          return { reply: { role: 'assistant', content: 'Something went wrong fetching services.' } };
        }
      } else {
        return { reply: { role: 'assistant', content: '❌ Please type a valid location number or name.' } };
      }
    }
  
    // -------------------------------
    // 💇 STEP 3 — Select Service
    // -------------------------------
    const services = (this as any).conversationHistory[sessionId + '_services'];
    const selectedService = (this as any).conversationHistory[sessionId + '_selectedService'];
  
    if (services && !selectedService) {
      const input = userMessage.trim().toLowerCase();
      const service =
        services[parseInt(input) - 1] ||
        services.find((s: any) => s.name.toLowerCase().includes(input));
  
      if (service) {
        (this as any).conversationHistory[sessionId + '_selectedService'] = service;
        delete (this as any).conversationHistory[sessionId + '_services']; // ✅ cleanup
        const cartId = (this as any).conversationHistory[sessionId + '_cartId'];
  
        // Add to cart
        try {
          const result = await this.mcpClient.callTool({
            name: 'addServiceToCart',
            arguments: { cartId, serviceId: service.id },
          });
        
          let selectedServicelist=JSON.parse(result?.content?.[0]?.text || '[]');
           

          const selectedServiceId = selectedServicelist?.addCartSelectedBookableItem?.cart?.selectedItems?.[0]?.id;
      
        if (!selectedServiceId) throw new Error('No selectedServiceId returned');
      
        console.log('🎯 Selected Service ID:', selectedServiceId);
        (this as any).conversationHistory[sessionId + '_selectedServiceId'] = selectedServiceId;


        } catch (err) {
          console.error('❌ addServiceToCart failed:', err);
          return { reply: { role: 'assistant', content: `Couldn't add ${service.name} to your cart.` } };
        }
  
        // Get bookable dates
        try {
          const today = new Date();
          const lower = today.toISOString().split('T')[0];
          const upper = new Date(today.getTime() + 7 * 86400000).toISOString().split('T')[0];
  
          const result: any = await this.mcpClient.callTool({
            name: 'cartBookableDates',
            arguments: { cartId, searchRangeLower: lower, searchRangeUpper: upper },
          });
  
          const dates = JSON.parse(result?.content?.[0]?.text || '[]');
          (this as any).conversationHistory[sessionId + '_bookableDates'] = dates;
  
          let reply = `You selected **${service.name}**, and it has been added to your cart.\n\nHere are the next available dates:\n`;
          reply += dates.length
            ? dates.map((d: string, i: number) => `${i + 1}. ${d}`).join('\n') +
              `\n\nPlease choose a date by typing the number or date.`
            : 'No available dates this week.';
  
          return { reply: { role: 'assistant', content: reply } };
        } catch (err) {
          console.error('❌ cartBookableDates failed:', err);
          return { reply: { role: 'assistant', content: `Couldn't fetch booking dates.` } };
        }
      } else {
        return { reply: { role: 'assistant', content: '❌ Please type a valid service number or name.' } };
      }
    }
  
    // -------------------------------
    // 📅 STEP 4 — Select Date → Times
    // -------------------------------
    const dates = (this as any).conversationHistory[sessionId + '_bookableDates'];
    const selectedDate = (this as any).conversationHistory[sessionId + '_selectedDate'];
  
    if (dates && !selectedDate) {
      const input = userMessage.trim();
      const date =
        dates[parseInt(input) - 1] || dates.find((d: string) => d.startsWith(input));
  
      if (date) {
        (this as any).conversationHistory[sessionId + '_selectedDate'] = date;
        delete (this as any).conversationHistory[sessionId + '_bookableDates']; // ✅ cleanup
        const cartId = (this as any).conversationHistory[sessionId + '_cartId'];
  
        try {
          // In the date → times selection step, save the full time slots:
          const result = await this.mcpClient.callTool({
            name: 'cartBookableTimes',
            arguments: { cartId, searchDate: date },
          });
          const slots = JSON.parse(result?.content?.[0]?.text || '[]');
          (this as any).conversationHistory[sessionId + '_bookableTimes'] = slots;

          // Update rendering logic for available times when replying, if needed
          const list = slots.map((t, i) => `${i + 1}. ${new Date(t.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`).join('\n');
          const reply = `📅 You selected **${date}**.\nHere are the available times:\n${list}\n\nPlease choose a time by typing the number.`;
          return { reply: { role: 'assistant', content: reply } };
        } catch (err) {
          console.error('❌ cartBookableTimes failed:', err);
          return { reply: { role: 'assistant', content: 'Failed to fetch available times.' } };
        }
      } else {
        return { reply: { role: 'assistant', content: '❌ Please type a valid date number or date format (YYYY-MM-DD).' } };
      }
    }


// -------------------------------
// 🕓 STEP 5 — Select Time → Reserve → Staff
// -------------------------------
const times = (this as any).conversationHistory[sessionId + '_bookableTimes'];
const selectedDateForStaff = (this as any).conversationHistory[sessionId + '_selectedDate'];
const selectedServiceForStaff = (this as any).conversationHistory[sessionId + '_selectedService'];


console.log(`selectedServiceForStaff ${ JSON.stringify(selectedServiceForStaff)}`);


if (times && selectedDateForStaff && selectedServiceForStaff) {
  const input = userMessage.trim();
  // Find the selected slot by number or by matching time string
  const timeSlot = times[parseInt(input) - 1] || times.find((t) => t.startTime.includes(input));

  if (timeSlot) {
    delete (this as any).conversationHistory[sessionId + '_bookableTimes']; // ✅ cleanup
    (this as any).conversationHistory[sessionId + '_selectedTime'] = timeSlot.startTime;

    const cartId = (this as any).conversationHistory[sessionId + '_cartId'];
    const itemId = selectedServiceForStaff.id;
    const bookableTimeId = timeSlot.id;
    const selectedServiceId = (this as any).conversationHistory[sessionId + '_selectedServiceId'];
    


    console.log('🕒 Selected slot:', {
      cartId,
      itemId,
      bookableTimeId,
      startTime: timeSlot.startTime,
    });

    try {
      // ✅ STEP 5.1: Reserve the selected time
      console.log('📦 Reserving cart bookable item...');
      const reserveResult: any = await this.mcpClient.callTool({
        name: 'reserveCartBookableItems',
        arguments: { cartId, bookableTimeId },
      });

      console.log(reserveResult);



      let reserveText = reserveResult?.content?.[0]?.text || '{}';
      let reserveData;
      try {
        reserveData = JSON.parse(reserveText);
      } catch {
        reserveData = {};
      }
      

      console.log('✅ cartId :', cartId);
      console.log('✅ bookableTimeId :', bookableTimeId);
      console.log('✅ selectedServiceId :', selectedServiceId);
      // ✅ STEP 5.2: Fetch available staff after successful reservation
      console.log('💼 Fetching staff variants...');


      const staffResult: any = await this.mcpClient.callTool({
        name: 'cartBookableStaffVariants',
        arguments: { id: cartId,   itemId: selectedServiceId, bookableTimeId },
      });

      let staffText = staffResult?.content?.[0]?.text;
      let staffData: any;
      try {
        staffData = typeof staffText === 'string' ? JSON.parse(staffText) : staffText;
      } catch (e) {
        console.error('⚠️ Failed to parse staff data:', e);
        staffData = [];
      }

      const staffList = Array.isArray(staffData)
        ? staffData
        : staffData?.cartBookableStaffVariants || staffData?.bookableStaffVariants || [];

console.log("staffList", JSON.stringify(staffList, null, 2));



      if (staffList.length > 0) {
        const list = staffList
          .map(
            (s: any, i: number) =>
              `${i + 1}. ${s.staff?.displayName || `${s.staff?.firstName || ''} ${s.staff?.lastName || ''}`.trim() || 'Unnamed'}`
          )
          .join('\n');

        const reply = `✅ You selected **${new Date(timeSlot.startTime).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}** on **${selectedDateForStaff}**.\n\nHere are the available estheticians:\n${list}\n\nPlease choose one by typing the number or name.`;

        (this as any).conversationHistory[sessionId + '_staffList'] = staffList;

        return { reply: { role: 'assistant', content: reply } };
      } else {
        const reply = `✅ You selected **${new Date(timeSlot.startTime).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}** on **${selectedDateForStaff}**, but no estheticians are available for that slot.`;
        return { reply: { role: 'assistant', content: reply } };
      }
    } catch (err) {
      console.error('❌ [STEP 5] reserveCartBookableItems or staff fetch failed:', err);
      return {
        reply: {
          role: 'assistant',
          content:
            '❌ Something went wrong while reserving your time or fetching estheticians. Please try another slot.',
        },
      };
    }
  } else {
    return { reply: { role: 'assistant', content: '❌ Please choose a valid time number.' } };
  }
}

// -------------------------------
// 💆 STEP 6 — Select Esthetician → Confirm Staff → Show Summary
// -------------------------------
const staffList = (this as any).conversationHistory[sessionId + '_staffList'];
const selectedTime = (this as any).conversationHistory[sessionId + '_selectedTime'];
const selectedServiceId = (this as any).conversationHistory[sessionId + '_selectedServiceId'];
const cartId = (this as any).conversationHistory[sessionId + '_cartId'];

if (staffList && selectedTime) {
  const input = userMessage.trim().toLowerCase();
  const selectedStaff =
    staffList[parseInt(input) - 1] ||
    staffList.find(
      (s: any) =>
        s.staff?.displayName?.toLowerCase().includes(input) ||
        `${s.staff?.firstName || ''} ${s.staff?.lastName || ''}`
          .trim()
          .toLowerCase()
          .includes(input)
    );

  if (selectedStaff) {
    delete (this as any).conversationHistory[sessionId + '_staffList']; // ✅ cleanup
    (this as any).conversationHistory[sessionId + '_selectedStaff'] = selectedStaff;

    try {
      console.log('💆 Updating cart with selected esthetician...');
      const updateResult: any = await this.mcpClient.callTool({
        name: 'updateCartSelectedBookableItem',
        arguments: {
          cartId,
          itemId: selectedServiceId,
          staffVariantId: selectedStaff.id,
        },
      });

      const updateText = updateResult?.content?.[0]?.text || '{}';
      const updateData = JSON.parse(updateText);

      console.log('✅ updateCartSelectedBookableItem result:', updateData);

      // ✅ After successful update → fetch summary
      console.log('🧾 Fetching cart summary...');
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

      const cartSummary =
        summaryData?.cart?.summary ||
        summaryData?.summary ||
        summaryData?.getCartSummary ||
        {};


      console.log("cartSummary", summaryData);

      const staffName =
        selectedStaff.staff?.displayName ||
        `${selectedStaff.staff?.firstName || ''} ${selectedStaff.staff?.lastName || ''}`.trim();

      const serviceName =
        (this as any).conversationHistory[sessionId + '_selectedService']?.name || 'selected service';

      const date = (this as any).conversationHistory[sessionId + '_selectedDate'];
      const time = new Date(selectedTime).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });

      let reply = `💆 You selected **${staffName}** for your **${serviceName}** on **${date}** at **${time}**.\n\n✅ Your service has been successfully updated in the cart.\n\n`;

      if (summaryData) {
        reply += `🧾 **Summary:**\nSubtotal: ${summaryData.summary.subtotal/100}\nTax: ${summaryData.summary.taxAmount/100}\nTotal: **${summaryData.summary.total/100}**\n\nWould you like to confirm your appointment now?`;

      } else {
        reply += `Would you like to confirm your appointment now?`;
      }

      return { reply: { role: 'assistant', content: reply } };
    } catch (err) {
      console.error('❌ updateCartSelectedBookableItem or getCartSummary failed:', err);
      return {
        reply: {
          role: 'assistant',
          content: '❌ Failed to assign esthetician or show summary. Please try again.',
        },
      };
    }
  } else {
    return {
      reply: {
        role: 'assistant',
        content: '❌ Please type a valid esthetician number or name.',
      },
    };
  }
}


  
    // -------------------------------
    // 🕓 STEP 5 — Select Time (end)
    // -------------------------------
    // const times = (this as any).conversationHistory[sessionId + '_bookableTimes'];
    // if (times) {
    //   const input = userMessage.trim();
    //   const time =
    //     times[parseInt(input) - 1] || times.find((t: string) => t.includes(input));
  
    //   if (time) {
    //     delete (this as any).conversationHistory[sessionId + '_bookableTimes']; // ✅ cleanup
  
    //     const reply = `✅ Great! You selected **${new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}** on **${(this as any).conversationHistory[sessionId + '_selectedDate']}**.\n\nWould you like to confirm this appointment?`;
    //     return { reply: { role: 'assistant', content: reply } };
    //   } else {
    //     return { reply: { role: 'assistant', content: '❌ Please choose a valid time number.' } };
    //   }
    // }
  
    // -------------------------------
    // 🧠 Fallback — OpenAI handles chat
    // -------------------------------
    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: this.conversationHistory[sessionId],
    });
    const message = completion.choices[0].message;
    this.conversationHistory[sessionId].push(message);
    return { reply: message };
  }
  
}

