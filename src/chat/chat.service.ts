import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

@Injectable()
export class ChatService {
  private openai: OpenAI;
  private mcpClient: Client;
  private conversationHistory: Record<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]> = {};

  private readonly TZ_OFFSET = '+05:30'; // Asia/Kolkata offset

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

  private formatDate(d: Date) {
    return d.toISOString().split('T')[0];
  }

  private parseTimeToHHMM(input: string | undefined): string | null {
    if (!input) return null;
    const s = input.trim().toLowerCase();
    const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const m = s.match(re);
    if (!m) return null;
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3] ? m[3].toLowerCase() : null;
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  }

  private buildDatetimeIso(dateYMD: string, hhmm: string | null) {
    const timePart = hhmm ? `${hhmm}:00` : '00:00:00';
    return `${dateYMD}T${timePart}${this.TZ_OFFSET}`;
  }
  private recoverUrn(
    history: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    kind: 'Cart' | 'Location' | 'Service',
  ): string | null {
    const pattern = new RegExp(`urn:blvd:${kind}:[0-9a-fA-F-]{36}`, 'g');
  
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (typeof m.content === 'string') {
        // Direct text search
        const match = m.content.match(pattern);
        if (match) return match[0];
  
        // Try parsing JSON too
        try {
          const parsed = JSON.parse(m.content);
          const jsonStr = JSON.stringify(parsed);
          const match2 = jsonStr.match(pattern);
          if (match2) return match2[0];
        } catch {
          // Ignore non-JSON messages
        }
      }
    }
    return null;
  }
  
  // Ensure bookableTimeId is in Boulevard expected format: t_YYYY-MM-DDTHH:MM:SS
  private normalizeBookableTimeId(raw?: string | null): string | undefined {
    if (!raw) return undefined;
    let s = raw.trim();

    // If already starts with t_ and looks like an ISO after that, return early
    if (s.startsWith('t_')) {
      return s;
    }

    // Remove wrapping quotes if any
    s = s.replace(/^"+|"+$/g, '');

    // If contains timezone offset (e.g., -08:00 or Z), strip it — Boulevard expects local-ish timestamp without offset
    // Example input: 2025-11-02T06:00:00-08:00  -> we want 2025-11-02T06:00:00
    s = s.replace(/(Z|[+-]\d{2}:\d{2})$/, '');

    // If it's an iso-like datetime, prefix with t_
    const isoLike = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$/;
    if (isoLike.test(s)) {
      // ensure seconds present
      if (s.length === 'YYYY-MM-DDTHH:MM'.length) {
        // unlikely, but pad
        s = `${s}:00`;
      } else if (s.length === 'YYYY-MM-DDTHH:MM:SS'.length) {
        // ok
      } else if (!s.includes(':')) {
        // fallback — don't modify
      }
      return `t_${s}`;
    }

    // If input is something like 't_2025-11-02T06:00:00-08:00', strip timezone and keep prefix
    const tWithTz = s.match(/^t_(.+?)(Z|[+-]\d{2}:\d{2})?$/);
    if (tWithTz) {
      const core = tWithTz[1].replace(/(Z|[+-]\d{2}:\d{2})$/, '');
      return `t_${core}`;
    }

    // If nothing matched, return undefined so caller can handle fallback
    return undefined;
  }

  async getResponse(userMessage: string, sessionId = 'default'): Promise<{ reply: { role: string; content: string } }> {
    if (!this.conversationHistory[sessionId]) {
      this.conversationHistory[sessionId] = [
        {
          role: 'system',
          content: `

You are a **strict Boulevard booking assistant**.
Follow this structured workflow step by step and do not skip any validation.

---

### 🟢 1️⃣ INITIAL GREETING

- When the user says **hi**, **hello**, **hey**, **help**, or anything similar:  

### 🟢 1️⃣ GREETING
- If user says hi/hello/hey/help → greet politely:
  "Hello! I'm here to help you book an appointment. Would you like to book one?"
- Wait for "yes" or "ok" → call "get_locations" and display locations from the tool (real data only).
- When a location is selected → immediately and call "createAppointmentCart" using the location ID.
- Do **not** show any cart creation details (IDs, deposits, or system info).
- After the cart is created → immediately call "availableServices" and show the list.

---

### 🟣 2️⃣ SERVICE SELECTION
- After a valid service is added → ask for appointment date.

---

### 🔵 3️⃣ DATE & TIME COLLECTION
- Ask for a preferred date → call "checkAvailability".
- Show available time slots.
- When a time is selected → confirm and show booking summary.

---

### 🟣 2️⃣ SERVICE SELECTION

- After the cart is created, call "availableServices" and show the list of services.
- Match services using fuzzy matching (e.g., “hydra” → “Hydra Facial”).
- Once the user selects a valid service → call "addServiceToCart".
- After adding a service, call cartBookableDates and show available dates to user.

---

### 🔵 3️⃣ DATE & TIME COLLECTION

- When the user provides a valid date → call the time-slot logic or "checkAvailability".
- Display available time slots.
- When the user selects a time → verify it silently, and **immediately show the booking summary** (do not ask for time again).
- If available → confirm and proceed.

---

### ⚙️ 4️⃣ BEHAVIOR RULES

- Be short, polite, and guided.
- Never skip ahead in the flow.
- Always call tools instead of assuming data.
- Never confirm a booking until verified.
- Never display internal or technical data (like cart IDs, client info, or raw API responses).

---


`,
        },
      ];
    }

    this.conversationHistory[sessionId].push({ role: 'user', content: userMessage });


// 🧠 Check if user selected a known location name and handle cart + services automatically
if (userMessage && userMessage.trim()) {
  // Find if userMessage matches any location name from previous get_locations result
  const hist = this.conversationHistory[sessionId];
  const lastLocations = hist.slice().reverse().find(m => m.role === 'function' && m.name === 'get_locations');

  if (lastLocations && typeof lastLocations.content === 'string') {
    try {
      const parsed = JSON.parse(lastLocations.content);
      const locations = Array.isArray(parsed) ? parsed : parsed.locations || [];

      const selected = locations.find((l: any) =>
        userMessage.toLowerCase().includes(l.name.toLowerCase())
      );

      if (selected) {

        // 1️⃣ Create cart
        const cartResult: any = await this.mcpClient.callTool({
          name: 'createAppointmentCart',
          arguments: { locationId: selected.id },
        });

        const cartText = cartResult?.content?.[0]?.text || '';
        const cartIdMatch = cartText.match(/urn:blvd:Cart:[0-9a-f-]+/);
        const cartId = cartIdMatch ? cartIdMatch[0] : null;

        if (cartId) {

          
          // 2️⃣ Fetch available services
          const svcResult: any = await this.mcpClient.callTool({
            name: 'availableServices',
            arguments: { cartId },
          });

        
          let svcText = svcResult?.content?.[0]?.text;
          let svcData: any;
          
          // 🧩 Step 1: Safely parse JSON if it's a string
          try {
            svcData = typeof svcText === 'string' ? JSON.parse(svcText) : svcText;
          } catch (e) {
            console.error('⚠️ Failed to parse service data:', e);
            svcData = {};
          }
          
          // 🧭 Step 2: Extract services cleanly from Boulevard cart structure
          const services =
            svcData?.cart?.availableCategories?.flatMap(
              (cat: any) => cat?.availableItems || []
            ) || [];
          
          // // 🧹 Step 3: Handle empty case
          // if (!Array.isArray(services) || services.length === 0) {
          //   return 'No services found for this location. Please try again later.';
          // }
          
          // 💬 Step 4: Build service list for user
          
          
          const svcList = services
            .map((s: any, i: number) => `${i + 1}. ${s.name}`)
            .join('\n');
          
          const reply = `Here are the available services at ${selected.name}:\n${svcList}`;
          
          //return reply;
          


          this.conversationHistory[sessionId].push({
            role: 'assistant',
            content: reply,
          });

          return { reply: { role: 'assistant', content: reply } };
        }
      }
    } catch (err) {
      console.error('⚠️ Auto createCart + availableServices failed:', err);
    }
  }
}




    // // 🔧 TEMPORARY TEST: Trigger static staffVariants on "hi"
    // if (userMessage.trim().toLowerCase() === 'hi') {
    //   console.log('👋 Triggering static cartBookableStaffVariants for test...');
    //   try {
    //     // use normalized t_ form here for the test payload
    //     const staticPayload = {
    //       id: 'urn:blvd:Cart:5f9d7d69-d60a-42fc-ac7a-461a7a17ea07',
    //       itemId: 'urn:blvd:Service:3ab640f0-7bdd-48d6-a95c-375e75092e67',
    //       // bookableTimeId: this.normalizeBookableTimeId('2025-11-02T06:00:00-08:00') || 't_2025-11-02T06:00:00',
    //       bookableTimeId: "t_2025-11-02T09:00:00"


    //     };

    //     const result: any = await this.mcpClient.callTool({
    //       name: 'cartBookableStaffVariants',
    //       arguments: staticPayload,
    //     });

    //     console.log("resultssss");
    //     console.log(result);
        

    //     const toolOutput = result?.content?.[0]?.text || JSON.stringify(result, null, 2);
    //     console.log('🧾 StaffVariants test output:', toolOutput);

    //     const staffSummary = await this.openai.chat.completions.create({
    //       model: 'gpt-4o-mini',
    //       temperature: 0.5,
    //       messages: [
    //         {
    //           role: 'system',
    //           content:
    //             'Summarize available estheticians in a friendly and short way (e.g., "You can choose between Sarah and Emily").',
    //         },
    //         { role: 'user', content: toolOutput },
    //       ],
    //     });

    //     const reply =
    //       staffSummary?.choices?.[0]?.message?.content ||
    //       'Here are the available estheticians for your selected time.';

    //     return { reply: { role: 'assistant', content: reply } };
    //   } catch (err) {
    //     console.error('❌ Test staffVariants call failed:', err);
    //     return {
    //       reply: { role: 'assistant', content: 'Unable to fetch staff list right now.' },
    //     };
    //   }
    // }

    // ⬇️ Normal flow: let model decide and possibly call tools



    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.35,
        messages: this.conversationHistory[sessionId],
        functions: this.getTools(),
        function_call: 'auto',
      });

      const message: any = completion?.choices?.[0]?.message || {};


    // 🚫 Skip showing internal cart creation response
    if (message.function_call === 'createAppointmentCart') {
      const cartId = this.recoverUrn(this.conversationHistory[sessionId], 'Cart');
      if (cartId) {
        try {
          const svcResult: any = await this.mcpClient.callTool({
            name: 'availableServices',
            arguments: { cartId },
          });
    
          const svcText = svcResult?.content?.[0]?.text || JSON.stringify(svcResult, null, 2);
    
          // Summarize services politely
          const svcSummary = await this.openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0.6,
            messages: [
              {
                role: 'system',
                content: 'List available salon services in a short, friendly way (e.g., “Here are some services you can choose from: …”).',
              },
              { role: 'user', content: svcText },
            ],
          });
    
          const svcMsg = svcSummary?.choices?.[0]?.message?.content || 'Here are the available services.';
    
          this.conversationHistory[sessionId].push({
            role: 'assistant',
            content: svcMsg,
          });
    
          return { reply: { role: 'assistant', content: svcMsg } };
        } catch (err) {
          console.error('❌ availableServices after createAppointmentCart failed:', err);
          return { reply: { role: 'assistant', content: 'Unable to load services right now.' } };
        }
      }
    }

    

      if (message.function_call) {
        const { name, arguments: args } = message.function_call;
        let parsedArgs: Record<string, any> = args ? JSON.parse(args as string) : {};
        console.log(`⚙️ OpenAI requested tool: ${name}`, parsedArgs);

        const hist = this.conversationHistory[sessionId];
        if (!parsedArgs.cartId) parsedArgs.cartId = this.recoverUrn(hist, 'Cart');
        if (!parsedArgs.locationId) parsedArgs.locationId = this.recoverUrn(hist, 'Location');
        if (!parsedArgs.serviceId) parsedArgs.serviceId = this.recoverUrn(hist, 'Service');

        // default window for dates
        if (name === 'cartBookableDates') {
          const today = new Date();
          const right = new Date(today);
          right.setDate(today.getDate() + 7);
          parsedArgs.searchRangeLower = this.formatDate(today);
          parsedArgs.searchRangeUpper = this.formatDate(right);
        }

        // normalize searchDate when cartBookableTimes requested
        if (name === 'cartBookableTimes') {
          let rawDate = parsedArgs.searchDate || userMessage;
          let normalizedDate: any = null;
          if (rawDate) {
            const d = new Date(rawDate);
            if (!isNaN(d.getTime())) normalizedDate = this.formatDate(d);
          }
          if (!normalizedDate) {
            const guess = `${rawDate} ${new Date().getFullYear()}`;
            const gd = new Date(guess);
            if (!isNaN(gd.getTime())) normalizedDate = this.formatDate(gd);
          }
          if (!normalizedDate) normalizedDate = this.formatDate(new Date());
          parsedArgs.searchDate = normalizedDate;
        }

        // If checkAvailability is invoked and user provided a textual time (or we can match bookableTimeId)
        if (name === 'checkAvailability' && !parsedArgs.datetime) {
          const rawDate = parsedArgs.date || parsedArgs.searchDate || this.formatDate(new Date());
          const rawTime = parsedArgs.time || userMessage;
          const dateYMD = rawDate ? this.formatDate(new Date(rawDate)) : this.formatDate(new Date());
          const hhmm = this.parseTimeToHHMM(rawTime || undefined);
          parsedArgs.datetime = this.buildDatetimeIso(dateYMD, hhmm);
        }

        // BEFORE calling cartBookableStaffVariants -> ensure bookableTimeId is normalized (t_ prefix, no tz)
        if (name === 'cartBookableStaffVariants') {
          // try to use parsedArgs.bookableTimeId first; else try to extract from last cartBookableTimes result in history
          let candidate = parsedArgs.bookableTimeId || null;

          // search previous cartBookableTimes function output for an iso or token
          if (!candidate) {
            const lastTimesResponse: any = hist
              .slice()
              .reverse()
              .find((m: any) => m.role === 'function' && (m.name === 'cartBookableTimes' || m.name === 'cartBookableTimes'));
            if (lastTimesResponse && typeof lastTimesResponse.content === 'string') {
              // content may be JSON array of iso strings, or a string containing IDs — try simple parse
              try {
                const parsed = JSON.parse(lastTimesResponse.content);
                if (Array.isArray(parsed) && parsed.length) {
                  // pick first element if looks like ISO or t_ format
                  candidate = String(parsed[0]);
                }
              } catch {
                // fallthrough: try regex search within text
                const m = lastTimesResponse.content.match(/t_[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/);
                if (m) candidate = m[0];
                else {
                  const isoMatch = lastTimesResponse.content.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/);
                  if (isoMatch) candidate = isoMatch[0];
                }
              }
            }
          }

          // normalize
          const normalized = this.normalizeBookableTimeId(candidate);
          if (normalized) {
            parsedArgs.bookableTimeId = normalized;
          } else {
            // as a last resort, try to parse user's raw message for a time and compose an ID using today's date (for dev/testing)
            const hhmm = this.parseTimeToHHMM(userMessage);
            if (hhmm) {
              const composed = `${this.formatDate(new Date())}T${hhmm}:00`;
              parsedArgs.bookableTimeId = this.normalizeBookableTimeId(composed) || `t_${composed}`;
            }
          }
        }

        
        // Call MCP tool
        try {
          const result: any = await this.mcpClient.callTool({
            name,
            arguments: parsedArgs,
          });

          const toolOutput = result?.content?.[0]?.text || JSON.stringify(result, null, 2);

          this.conversationHistory[sessionId].push({
            role: 'function',
            name,
            content: toolOutput,
          });

          // Auto-fetch staff immediately after cartBookableTimes (if the tool returned bookable time ids)
          if (name === 'cartBookableTimes') {
            const cartId = parsedArgs.cartId || parsedArgs.id || this.recoverUrn(hist, 'Cart');
            // try to extract a bookableTime token (either t_... or BookableTime URN or iso)
            let bookableToken: string | null = null;
            try {
              // toolOutput often contains an array of ISO strings -> if so pick first and normalize
              const parsed = JSON.parse(toolOutput);
              if (Array.isArray(parsed) && parsed.length) {
                bookableToken = String(parsed[0]);
              }
            } catch {
              // fallback regex
              const m = toolOutput.match(/t_[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/);
              if (m) bookableToken = m[0];
              else {
                const isoMatch = toolOutput.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/);
                if (isoMatch) bookableToken = isoMatch[0];
              }
            }

            if (cartId && bookableToken) {
              const normalized = this.normalizeBookableTimeId(bookableToken) || (bookableToken.startsWith('t_') ? bookableToken : `t_${bookableToken}`);
              // attempt staff fetch
              try {
                const staffResult = await this.mcpClient.callTool({
                  name: 'cartBookableStaffVariants',
                  arguments: {
                    id: cartId,
                    itemId: parsedArgs.serviceId || parsedArgs.itemId,
                    bookableTimeId: normalized,
                  },
                });

                const staffList = staffResult?.content?.[0]?.text || JSON.stringify(staffResult, null, 2);

                const staffSummary = await this.openai.chat.completions.create({
                  model: 'gpt-4o-mini',
                  temperature: 0.6,
                  messages: [
                    {
                      role: 'system',
                      content:
                        'Summarize available estheticians from the tool result (e.g., "You can choose between Sarah and Emily").',
                    },
                    { role: 'user', content: staffList },
                  ],
                });

                const staffMsg =
                  staffSummary?.choices?.[0]?.message?.content ||
                  'Here are the available estheticians for your selected time.';

                this.conversationHistory[sessionId].push({
                  role: 'assistant',
                  content: staffMsg,
                });

                return { reply: { role: 'assistant', content: staffMsg } };
              } catch (err) {
                console.error('❌ Auto staff fetch after cartBookableTimes failed:', err);
                // fallthrough to normal summarization
              }
            }
          }

          // // Default summarization for other tools
          // const summary = await this.openai.chat.completions.create({
          //   model: 'gpt-4o-mini',
          //   temperature: 0.6,
          //   messages: [
          //     { role: 'system', content: 'Summarize tool result briefly and politely.' },
          //     { role: 'user', content: `Tool "${name}" returned: ${toolOutput}` },
          //   ],
          // });


          // ✅ Handle specific tool outputs directly for clarity
let assistantMessage = '';
if (name === 'get_locations') {
  try {
    const parsed = JSON.parse(toolOutput);
    // Some MCP tools return { locations: [...] } instead of plain array
    const locations = Array.isArray(parsed) ? parsed : parsed?.locations || [];
    if (locations.length > 0) {
      const locList = locations
        .map((l: any, i: number) => `${i + 1}. ${l.name}${l.address?.city ? ` (${l.address.city})` : ''}`)
        .join('\n');
      assistantMessage = `Here are the available locations:\n${locList}\n\nPlease choose one.`;
    } else {
      assistantMessage = 'No locations were found for now.';
    }
  } catch (err) {
    console.error('⚠️ get_locations parsing failed:', err);
    assistantMessage = `Here are the available locations:\n${toolOutput}`;
  }

} else if (name === 'availableServices') {
  try {
    const parsed = JSON.parse(toolOutput);
    const services = Array.isArray(parsed) ? parsed : parsed?.services || [];
    if (services.length > 0) {
      const svcList = services.map((s: any, i: number) => `${i + 1}. ${s.name}`).join('\n');
      assistantMessage = `Here are the services you can choose from:\n${svcList}`;
    } else {
      assistantMessage = 'No services were found for this location.';
    }
  } catch (err) {
    console.error('⚠️ availableServices parsing failed:', err);
    assistantMessage = `Here are the available services:\n${toolOutput}`;
  }
} else if (name === 'addServiceToCart') {
  // ✅ After successfully adding a service, automatically call cartBookableDates
  try {
    const cartId = parsedArgs.cartId;
    const locationId = parsedArgs.locationId;

    if (cartId && locationId) {
      const today = new Date();
      const upper = new Date(today);
      upper.setDate(today.getDate() + 7);

      const datesResult: any = await this.mcpClient.callTool({
        name: 'cartBookableDates',
        arguments: {
          cartId,
          locationId,
          searchRangeLower: this.formatDate(today),
          searchRangeUpper: this.formatDate(upper),
        },
      });

      console.log(`datesResult : ${datesResult}`);


      const datesText = datesResult?.content?.[0]?.text || '[]';
      let parsedDates: string[] = [];

      try {
        parsedDates = JSON.parse(datesText);
      } catch {
        console.warn('⚠️ cartBookableDates parse failed:', datesText);
      }

      console.log(parsedDates);
      



      if (Array.isArray(parsedDates) && parsedDates.length > 0) {
        const formatted = parsedDates
          .slice(0, 7)
          .map((d: string, i: number) => `${i + 1}. ${d}`)
          .join('\n');
        assistantMessage = `Great! Your service has been added successfully.\n\nHere are the available dates for booking:\n${formatted}\n\nPlease pick a date.`;
      } else {
        assistantMessage = `Service added successfully, but no available dates found. Try again later.`;
      }
    } else {
      assistantMessage = `Service added successfully.`;
    }
  } catch (err) {
    console.error('⚠️ addServiceToCart + cartBookableDates failed:', err);
    assistantMessage = `Service added successfully, but unable to load available dates.`;
  }}


          // const assistantMessage =
          //   summary?.choices?.[0]?.message?.content || 'Done.';

          this.conversationHistory[sessionId].push({
            role: 'assistant',
            content: assistantMessage,
          });

          return { reply: { role: 'assistant', content: assistantMessage } };
        } catch (err: any) {
          console.error(`❌ MCP tool ${name} failed:`, err);
          return {
            reply: {
              role: 'assistant',
              content: `There was an issue running ${name}. Please check the input.`,
            },
          };
        }
      }

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
        reply: { role: 'assistant', content: 'Unexpected error occurred. Please try again.' },
      };
    }
  }

  private getTools() {
    return [
      { name: 'get_locations', description: 'Fetch available Boulevard business locations.', parameters: { type: 'object', properties: {} } },
      { name: 'createAppointmentCart', description: 'Create a booking cart for a location.', parameters: { type: 'object', properties: { locationId: { type: 'string' } }, required: ['locationId'] } },
      { name: 'availableServices', description: 'List available services in current cart.', parameters: { type: 'object', properties: { cartId: { type: 'string' } }, required: ['cartId'] } },
      { name: 'addServiceToCart', description: 'Add selected service to cart.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, serviceId: { type: 'string' } }, required: ['cartId', 'serviceId'] } },
      { name: 'cartBookableDates', description: 'Fetch available booking dates.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, locationId: { type: 'string' }, searchRangeLower: { type: 'string' }, searchRangeUpper: { type: 'string' } }, required: ['cartId', 'locationId', 'searchRangeLower', 'searchRangeUpper'] } },
      { name: 'cartBookableTimes', description: 'Fetch available time slots for a date.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, locationId: { type: 'string' }, serviceId: { type: 'string' }, searchDate: { type: 'string' } }, required: ['cartId', 'locationId', 'serviceId', 'searchDate'] } },
      { name: 'cartBookableStaffVariants', description: 'Fetch available estheticians (staff) for a selected time.', parameters: { type: 'object', properties: { id: { type: 'string' }, itemId: { type: 'string' }, bookableTimeId: { type: 'string' } }, required: ['id', 'itemId', 'bookableTimeId'] } },
      { name: 'checkAvailability', description: 'Check appointment availability.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, serviceId: { type: 'string' }, datetime: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' } }, required: ['cartId', 'serviceId'] } },
      { name: 'setClientOnCart', description: 'Attach client info to cart.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string' }, phoneNumber: { type: 'string' } }, required: ['cartId', 'firstName', 'lastName', 'email', 'phoneNumber'] } },
      { name: 'tokenizeCard', description: 'Tokenize a credit card securely.', parameters: { type: 'object', properties: { name: { type: 'string' }, number: { type: 'string' }, cvv: { type: 'string' }, exp_month: { type: 'number' }, exp_year: { type: 'number' }, address_postal_code: { type: 'string' } }, required: ['name', 'number', 'cvv', 'exp_month', 'exp_year', 'address_postal_code'] } },
      { name: 'addCartCardPaymentMethod', description: 'Attach tokenized card to cart.', parameters: { type: 'object', properties: { cartId: { type: 'string' }, token: { type: 'string' }, select: { type: 'boolean' } }, required: ['cartId', 'token'] } },
      { name: 'checkoutCart', description: 'Complete the checkout.', parameters: { type: 'object', properties: { cartId: { type: 'string' } }, required: ['cartId'] } },
    ];
  }
}


