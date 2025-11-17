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
  public paymentToken: string | null = null;
  email:any;
  totalAmount:any;
  toolCache:any;
  private sessionState: Record<string, {
    cartId?: string;
    serviceItemId?: string;
    bookableTimeId?: string;
    staffVariantId?: string;
    clientEmail?:string;
    totalAmount?;
  }> = {};


  // conversationHistory now stores messages only; state is managed by the AI's reasoning.
  private conversationHistory: Record<string, OpenAI.Chat.Completions.ChatCompletionMessageParam[]> = {};

  constructor() {
    this.initialize();
  }// Inside ChatService class:

async setPaymentToken(token: string, sessionId = 'default'): Promise<any> {
  console.log('💳 Received token from frontend:', token);

  console.log("timeid",this.sessionState[sessionId].bookableTimeId) 

  const session = this.sessionState[sessionId];
  const cartId = session?.cartId;
  console.log("session data >>> ",session)
  // const bookableTimeId = session?.bookableTimeId; // <-- Crucial ID for re-reservation
  // console.log("timeid",session?.bookableTimeId) 



  if (!cartId) { // Check for both critical IDs
    console.warn('⚠️ Cannot proceed with payment: Cart ID');
    // If the cart is missing, this is a terminal error for the session.
    return { 
      reply: { 
        role: 'assistant', 
        content: 'I am sorry, but the booking data is incomplete. The session may have expired. Please start the booking process again.'
      } 
    };
  }

  this.paymentToken = token;

  try {
    // 🛑 DEFENSIVE GUARDRAIL: RE-RESERVE BOOKABLE ITEMS 🛑
    // Ensure the staff selection is confirmed and the time slot is reserved before checkout.
    // This step acts as a safety net if the LLM missed the CRITICAL STEP CHAINING 3.
    // console.log('🛡️ Pre-Checkout Check: Attempting to reserve bookable items...');
    // const reserveResult: any = await this.mcpClient.callTool({
    //   name: 'reserveCartBookableItems',
    //   arguments: {
    //     cartId: cartId,
    //     bookableTimeId: bookableTimeId,
    //   },
    // });
    // console.log('✅ Defensive Reserve successful:', JSON.stringify(reserveResult, null, 2));

    // 1️⃣ Add payment method
    await this.mcpClient.callTool({
      name: 'addCartCardPaymentMethod',
      arguments: { cartId, token: this.paymentToken, select: true },
    });

    // 2️⃣ Checkout
    const checkoutResult: any = await this.mcpClient.callTool({
      name: 'checkoutCart',
      arguments: { cartId },
    });
    // ... (rest of the successful checkout logic remains the same)
    console.log('🛒 Cart checked out successfully:', checkoutResult);

    // Parse checkout response
    const checkoutData = JSON.parse(checkoutResult.content[0].text).checkoutCart;

    const cart = checkoutData.cart;
    const client = cart.clientInformation;
    const location = cart.location;
    const selectedItem = cart.selectedItems[0];
    const staff = selectedItem.selectedStaffVariant?.staff?.displayName || 'assigned staff';
    const serviceName = selectedItem.item?.name || selectedItem.id;
    const dateTime = cart.startTime || 'scheduled time';
    const totalUSD = (cart.summary.total ?? 0) / 100;
    const formattedTotal = `$${totalUSD.toFixed(2)}`;

    const startDate = new Date(cart.startTime);
    const formattedDate = startDate.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    const formattedTime = startDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit', 
      hour12: true 
    });


    // Build JSON response
    const response = {
      reply: {
        role: 'assistant',
        content: `Your appointment is now fully confirmed! Here are the final details:\n\n### Appointment Confirmation\n- **Date:** ${formattedDate}\n- **Time:** ${formattedTime}\n- **Service:** ${serviceName}\n- **Staff:** ${staff}\n- **Total Amount:** ${formattedTotal}\n\n### Client Details\n- **First Name:** ${client.firstName}\n- **Last Name:** ${client.lastName}\n- **Email:** ${client.email}\n- **Phone Number:** ${client.phoneNumber}\n\nIf you have any further questions or need anything else, feel free to ask! Thank you for choosing ${location.name}!`,
        refusal: null,
        annotations: [],
      }
    };

    return response;

  } catch (err: any) {
    console.error('❌ Failed to add payment method or checkout:', err.message);
    // Return a structured error response
    return { 
      reply: { 
        role: 'assistant', 
        content: `I apologize, but the payment or final booking step failed. Please ensure your card details are correct or try again. Error details: ${err.message}`
      }
    };
  }
}
  
  private async initialize() {
    // Ensure API Key is available
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    // Setup MCP Client Transport
    const transport = new StdioClientTransport({
      command: 'node',
      //args: ['dist/membership-booking.js'],
      args: ['dist/giftcard-purchase.js'],
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
          description: '**MANDATORY AFTER STAFF SELECTION:** Reserves/confirms the chosen time slot and staff assignment. MUST be called immediately after updateCartSelectedBookableItem. This locks in the booking details.',
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

      {
        type: 'function',
        function: {
          name: 'setClientOnCart',
          description: 'Attaches client information to the cart before checkout (first name, last name, email, phone number).',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string', description: 'Existing cart ID.' },
              firstName: { type: 'string', description: 'User first name.' },
              lastName: { type: 'string', description: 'User last name.' },
              email: { type: 'string', description: 'User email address.' },
              phoneNumber: { type: 'string', description: 'User phone number.' },
            },
            required: ['cartId', 'firstName', 'lastName', 'email', 'phoneNumber'],
          },
        },
      },

      {
        type: 'function',
        function: {
          name: 'addCartCardPaymentMethod',
          description: 'Attaches a tokenized card payment method to an existing Boulevard cart.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string', description: 'Existing cart ID.' },
              token: { type: 'string', description: 'Card token returned from tokenizeCard tool.' },
              select: {
                type: 'boolean',
                description: 'Whether to set this card as the selected payment method.',
                default: true,
              },
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
            properties: {
              cartId: {
                type: 'string',
                description: 'Existing cart ID (e.g., urn:blvd:Cart:23f5903a-3476-478a-8096-da405bf11d53).',
              },
            },
            required: ['cartId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'getCartSummary',
          description: 'Retrieves the final summary and total price of the cart. Use before asking for final confirmation.',
          parameters: {
            type: 'object',
            properties: { cartId: { type: 'string' } },
            required: ['cartId'],
          },
        },
      },
    ];
  }


  private getMembershipTools(): OpenAI.Chat.Completions.ChatCompletionTool[]{
    return [
      {
        type: 'function',
        function: {
          name: 'getLocations',
          description: 'Fetches all available locations for membership. Use this first.',
          parameters: { type: 'object', properties: {} },
        },
      },

      {
        type: 'function',
        function: {
          name: 'getMembershipPlans',
          description: 'Fetches all available membership.',
          parameters: { type: 'object', properties: {} },
        },
      },

      {
        type: 'function',
        function: {
          name: 'createMembershipCart',
          description: 'Creates a new membership cart for a specified location. Requires locationId.',
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
          name: 'addMemberhipToCart',
          description: 'Purchase a membership for a specified item. Requires itemId.',
          parameters: {
            type: 'object',
            properties: { 
              id: { type: 'string'},
              itemId: { type: 'string', description: 'returned from Selected Membership.' },
            },
            required: ['id','itemId'],
          },
        },
      },


      {
        type: 'function',
        function: {
          name: 'setClientOnCart',
          description: 'Attaches client information to the cart before checkout (first name, last name, email, phone number).',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string', description: 'Existing cart ID.' },
              firstName: { type: 'string', description: 'User first name.' },
              lastName: { type: 'string', description: 'User last name.' },
              email: { type: 'string', description: 'User email address.' },
              phoneNumber: { type: 'string', description: 'User phone number.' },
            },
            required: ['cartId', 'firstName', 'lastName', 'email', 'phoneNumber'],
          },
        },
      },

      {
        type: 'function',
        function: {
          name: 'addCartCardPaymentMethod',
          description: 'Attaches a tokenized card payment method to an existing Boulevard cart.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string', description: 'Existing cart ID.' },
              token: { type: 'string', description: 'Card token returned from tokenizeCard tool.' },
              select: {
                type: 'boolean',
                description: 'Whether to set this card as the selected payment method.',
                default: true,
              },
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
            properties: {
              cartId: {
                type: 'string',
                description: 'Existing cart ID (e.g., urn:blvd:Cart:23f5903a-3476-478a-8096-da405bf11d53).',
              },
            },
            required: ['cartId'],
          },
        },
      },
      // {
      //   type: 'function',
      //   function: {
      //     name: 'getCartSummary',
      //     description: 'Retrieves the final summary and total price of the cart. Use before asking for final confirmation.',
      //     parameters: {
      //       type: 'object',
      //       properties: { cartId: { type: 'string' } },
      //       required: ['cartId'],
      //     },
      //   },
      // },


    ]
  }



  private getGiftcardTools(): OpenAI.Chat.Completions.ChatCompletionTool[]{
    return [
      {
        type: 'function',
        function: {
          name: 'createGiftCardCart',
          description: 'Create cart with static location id. Use this first.',
          parameters: { type: 'object', properties: {} },
        },
      },

      {
        type: 'function',
        function: {
          name: 'availableServicesGiftCard',
          description: 'Fetch all available gift card slot .',
          parameters: {
            type: 'object',
            properties: { cartId: { type: 'string', description: 'The ID of the Cart.' } },
            required: ['cartId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'addGiftCardToCart',
          description: 'buy a giftcard. Requires itemId,itemPrice.',
          parameters: {
            type: 'object',
            properties: { 
              id: { type: 'string', description: 'Cart ID.'},
              itemId: { type: 'string', description: 'ItemId of the data set GIFT_CARD as itemId if not found.' },
              itemPrice: { type: 'number', description: 'returned from Selected giftcard.' },
            },
            required: ['id','itemId','itemPrice'],
          },
        },
      },

      {
        type: 'function',
        function: {
          name: 'updateGiftCardEmail',
          description: 'Attaches client information to the cart before checkout (first name, last name, email, phone number).',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Existing cart ID.' },
              itemId: {type: 'string', description: 'Selected card id.'},
              itemPrice: {type: 'string', description: 'Selected card price.'},
              recipientName: { type: 'string', description: 'given giftcard recipient name.' },
              recipientEmail: { type: 'string', description: 'given giftcard recipient email.' },
              senderName: { type: 'string', description: 'given giftcard sender name.' },
              deliveryDate: { type: 'string', description: 'selected giftcard delivery date.' },
            },
            required: ['id', 'itemId', 'itemPrice', 'recipientName', 'recipientEmail', 'senderName', 'deliveryDate'],
          },
        },
      },

      {
        type: 'function',
        function: {
          name: 'setClientOnCart',
          description: 'Attaches client information to the cart before checkout (first name, last name, email, phone number).',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string', description: 'Existing cart ID.' },
              firstName: { type: 'string', description: 'User first name.' },
              lastName: { type: 'string', description: 'User last name.' },
              email: { type: 'string', description: 'User email address.' },
              phoneNumber: { type: 'string', description: 'User phone number.' },
            },
            required: ['cartId', 'firstName', 'lastName', 'email', 'phoneNumber'],
          },
        },
      },

      {
        type: 'function',
        function: {
          name: 'addCartCardPaymentMethod',
          description: 'Attaches a tokenized card payment method to an existing Boulevard cart.',
          parameters: {
            type: 'object',
            properties: {
              cartId: { type: 'string', description: 'Existing cart ID.' },
              token: { type: 'string', description: 'Card token returned from tokenizeCard tool.' },
              select: {
                type: 'boolean',
                description: 'Whether to set this card as the selected payment method.',
                default: true,
              },
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
            properties: {
              cartId: {
                type: 'string',
                description: 'Existing cart ID (e.g., urn:blvd:Cart:23f5903a-3476-478a-8096-da405bf11d53).',
              },
            },
            required: ['cartId'],
          },
        },
      }

    ]
  }

private buildSystemPrompt(userSelection): OpenAI.Chat.Completions.ChatCompletionMessageParam {

  console.log("userSelection  >> ",userSelection)
  const getTodayDate = () => {
    const today = new Date();
    return today.toISOString().split('T')[0];
  };

  // Step 1: If no selection yet → ask user first
  if (!userSelection) {
    return {
      role: 'system',
      content: `
        You are an intelligent and conversational assistant for a salon & spa system.
        Your first task is to understand what the user wants to do.

        Ask the user clearly:

        **"Would you like to go with Booking an appointment, managing a Membership or giftcard purchase?"**

        Once the user responds:
        - If they say “booking”, “appointment”, “schedule”, etc., switch to the **booking module**.
        - If they say “membership”, “plan”, “package”, etc., switch to the **membership module**.
        - If they say giftcard, gift, present, etc., switch to the **giftcard module**.

        Keep the conversation polite and friendly.

        Do not start any booking, membership or giftcard action until the user makes a choice.
      `,
    };
  }

  // Step 2: Membership module
  if (userSelection === 'membership') {
    return {
      role: 'system',
      content: `
        You are a smart, friendly, and detail-oriented **Membership Management AI**.
        Your goal is to help users understand, purchase, and manage their salon or spa memberships.

        ## 🎯 Core Objectives:
        1. **Understand Intent:** Identify if the user wants to buy, renew, upgrade, cancel, or check details of a membership.
        2. **Provide Clear Options:** When listing memberships, show:
          - Name
          - Price (formatted in $X.XX)
          - Benefits or duration
        3. **Flow Logic:**
          - Step 1: Show location list (\`getLocations\`)
          - Step 2: Ask user to pick one
          - Step 3: update \'createAppointmentCart\' api
          - Step 4: Show available memberships (\`getMembershipPlans\`)
          - Step 5: Ask user to pick one
          - Step 6: Confirm choice and update \`addMemberhipToCart\`
          - Step 7: Confirm choice and collect user details (name, email, phone)
          - Step 8: after collect details update \`setClientOnCart\`
          - Step 9: wait for token which is coming from another screen
          - Step 9: when token is received successfully then call \'addCartCardPaymentMethod\'
          - Step 10: when 'addCartCardPaymentMethod' responsed success then call \'checkoutCart\'

        4. **🛑 CRITICAL PAYMENT GATE (STOP FOR TOKEN) 🛑:**
        * **ABSOLUTE RULE:** After the **\`setClientOnCart\`** tool is successfully called, you **MUST NOT** call any further tools, including \`getCartSummary\`.
        * You **MUST** respond conversationally to the user to inform them that their details are set and they can now proceed to payment/checkout.
        * **The remaining checkout steps are locked until a payment token is received.**
        
        5. **Conversational Flexibility:**
          - If the user asks to “book” a service, politely redirect them to the booking module.
        6. **Presentation Rules:**
          - Use Markdown for clarity when listing plans and benefits.
              `,
    };
  }

   // Step 2: Giftcard module
   if (userSelection === 'giftcard') {
    return {
      role: "system",
      content: `
    You are **GiftCard AI**, and your only job is to help users purchase Gift Cards.
    
    ---
    
    # 🎯 MAIN LOGIC
    
    ### STEP 1 — createGiftCardCart
    When user shows interest in gift cards, call \`createGiftCardCart\`.
    
    ### STEP 2 — availableServicesGiftCard
    After creating the cart, call \`availableServicesGiftCard\`.
    
    ### STEP 3 — EXTRACT, FORMAT, AND DISPLAY GIFT CARD DATA (CRITICAL)
    
    **Goal:** Display the item \`name\` and format its \`pricePresets\` as a clear list.
    
    **Example Data Structure you will encounter:**
    
    \`\`\`json
    {"name":"Gift Card","pricePresets":[2500,5000,10000,20000,25000]}
    \`\`\`
    
    1. **Iterate and Identify:** Find all items across all categories that have a non-empty, valid array in their **\`pricePresets\`** property.
    
    2. **Format Prices:** All values in \`pricePresets\` are given in **cents/minor currency unit**. You must divide each value by 100 and format it as a currency (e.g., $25.00).
    
    3. **Generate the Display List (Strict Format):**
       Combine the formatted item name and prices into a highly readable list structure.
    
    **🎁 Available Gift Cards**
    - **[Item Name]**
      💵 $[Price 1] • $[Price 2] • $[Price 3] • ...
    
    *Example Output:*
    **🎁 Available Gift Cards**
    - **Gift Card**
      💵 $25.00 • $50.00 • $100.00 • $200.00 • $250.00
    
    THEN ASK:
    **“Which gift card type and amount would you like to choose?”**
    
    Do NOT call \`addGiftCardToCart\` until the user selects a valid amount for a listed item. If no valid items are found, tell the user, "I apologize, no gift cards are currently available."
    
    ---
    
    ### STEP 4 — addGiftCardToCart
    Call this **ONLY** after the user selects a preset amount and item name (e.g., "Gift Card for $200"). **The amount passed to the tool must be the original value in cents (e.g., 20000 for $200.00).**
    
    ---
    
    ### STEP 5 — Collect User Details
    Ask for:
    - First name
    - Last name
    - Email
    - Phone number
    
    After ALL details are collected → call \`setClientOnCart\`.
    
    ---
    
    # 🛑 PAYMENT STOP POINT
    After calling \`setClientOnCart\`:
    
    - Do NOT call any more tools.
    - Tell user:  
      **“Your details are saved. Please proceed to payment.”**
    - Wait for a payment token from another screen.
    
    ---
    
    ### When the token arrives:
    1. Call \`addCartCardPaymentMethod\`  
    2. Then call \`checkoutCart\`  
    3. Confirm the gift card purchase
    
    ---
    
    # RULES
    - **Currency Conversion:** Always convert \`pricePresets\` values from cents (e.g., 2500) to dollars (e.g., $25.00) for display.
    - **STRICTLY:** Only display items that contain a valid and non-empty **\`pricePresets\`** array.
    - Use markdown for lists.
    - Stay friendly and concise.
    - Only continue when user provides required info.
    
    ---
    `
    }
    
    
    
    
    
  }

  //return { role: 'system',content:''};
  // Step 4: Booking module (your existing booking prompt)
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
  * **CRITICAL STEP CHAINING 3 (Staff/Time Re-Reservation - ABSOLUTELY MANDATORY CHAIN):** After a staff member is selected, the tool chain **MUST** be: **\`updateCartSelectedBookableItem\` $\rightarrow$ \`reserveCartBookableItems\`**. You **MUST NOT** proceed to \`setClientOnCart\`  or any other step until **\`reserveCartBookableItems\`** has been successfully called *immediately* after **\`updateCartSelectedBookableItem\`**. This sequence is **non-negotiable** for confirming the staff/time selection.  


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

14. **MANDATORY CLIENT DETAILS COLLECTION (CRITICAL STOP AND CONVERSATIONAL REQUIREMENT):**
    * **ABSOLUTE RULE:** After a successful **\`reserveCartBookableItems\`** call (whether from the initial time selection or the staff re-reservation), you **MUST STOP** the tool-calling loop and provide a **TEXT RESPONSE** to the user. This text response **MUST** ask the user to provide their First Name, Last Name, Email, and Phone Number.
    * **NEVER EVER** call **\`setClientOnCart\`** until the user has supplied all four pieces of information in a single, subsequent message.    * **DO NOT** call **\`setClientOnCart\`** or **\`getCartSummary\`** until the user has provided all four required details in a subsequent message.

15.  **🛑 CRITICAL CART ID INTEGRITY (CHECK FOR CORRUPTION) 🛑:**
    * The **Cart ID** is established *only* by the **\`createAppointmentCart\`** tool and always begins with **\`urn:blvd:Cart:\`**, followed by a long unique identifier.
    * ⚠️ **NEVER EVER** use a truncated Cart ID (for example, **\`urn:blvd:Cart:\`**).  
      You **MUST** use the complete ID (for example, **\`urn:blvd:Cart:ac67fb72-8c8f-4cef-b992-b9f9ffdfa510\`**) when calling **\`setClientOnCart\`**, **\`getCartSummary\`**, or **\`confirmBooking\`**.
    * If the Cart ID is missing, incomplete, or corrupted, you **MUST** inform the user that the cart session is invalid and that the booking process must restart.

16. **🛑 CRITICAL PAYMENT GATE (STOP FOR TOKEN) 🛑:**
    * **ABSOLUTE RULE:** After the **\`setClientOnCart\`** tool is successfully called, you **MUST NOT** call any further tools, including \`getCartSummary\`.
    * You **MUST** respond conversationally to the user to inform them that their details are set and they can now proceed to payment/checkout.
    * **The remaining checkout steps are locked until a payment token is received.**
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

  // Function for context management using programmatic state extraction
  private async pruneHistoryForState(sessionId: string, userMessage:string): Promise<void> {
    const history = this.conversationHistory[sessionId];
    const PRUNE_THRESHOLD = 20; // Prune if history is too long (e.g., more than 20 messages)

    // Check if pruning is necessary and we have at least the System Prompt and the first User Message
    if (history.length > PRUNE_THRESHOLD && history.length > 2) {
        console.log(`🧹 Pruning history: ${history.length} messages. Programmatically summarizing state...`);
        
        // Programmatically extract the state
        const summary = this.extractStateFromHistory(history);
        
        // Only prune if we successfully extracted critical state information
        if (!summary) {
            console.log('⚠️ Pruning skipped: No critical state IDs found to summarize.');
            return;
        }

        console.log('✅ State Summarized:', summary);

        // Rebuild the history: System Prompt + State Summary + Current User Message
        // The current user's message is the last element in the array
        const currentUserMessage = history[history.length - 1]; 
       // const userIntent = this.detectIntentFromUserMessage(userMessage);

      const userIntent:any = this.detectIntentFromUserMessage(userMessage);

        this.conversationHistory[sessionId] = [
            this.buildSystemPrompt(userIntent), // The latest system rules
            { 
                role: 'user', 
                content: `[SYSTEM MEMORY PRUNING]: The established booking state is: ${summary}` 
            },
            currentUserMessage // The message that needs to be addressed next
        ];
        
        console.log(`✂️ History pruned. New length: ${this.conversationHistory[sessionId].length}`);
    }
  }


  // The simplified, AI-driven getResponse function
  async getResponse(userMessage: string, sessionId = 'default') {
    console.log("userMessage  >> ",userMessage);
    let userIntent: any = "giftcard";
    if (!this.conversationHistory[sessionId]) {
      // Initialize with the comprehensive system prompt
      userIntent = this.detectIntentFromUserMessage(userMessage);
      console.log("userIntent  >> ",userIntent)
      this.conversationHistory[sessionId] = [this.buildSystemPrompt(userIntent)];
    }

    console.log("testttt")
    // Add the user's latest message to the history
    this.conversationHistory[sessionId].push({ role: 'user', content: userMessage });
    
    // CRITICAL: Check and prune history before starting the main loop
    await this.pruneHistoryForState(sessionId,userMessage);

    let response: OpenAI.Chat.Completions.ChatCompletion = null as any;
    // Set a loop limit to prevent runaway function calls
    let funcName:any;
    for (let i = 0; i < 5; i++) {
      console.log(`\n➡️ LLM Call ${i + 1}: Sending ${this.conversationHistory[sessionId].length} messages...`);

      // const summaryPrompt:any = [
      //   { role: 'system', content: 'Summarize the key points of this chat briefly:' },
      //   ...this.conversationHistory[sessionId].slice(0, -10)
      // ];

     // if (!this.toolCache[sessionId]) {
       // this.toolCache[sessionId] = this.getGiftcardTools();
      //}


      try {
        response = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini', // The model must support tool-calling
          messages: this.conversationHistory[sessionId],
          tools: this.getGiftcardTools(),//this.getGiftcardTools(),
         // tools: (userIntent == "membership")?this.getMembershipTools():this.getBookingTools(),  // Provide all available MCP functions
          tool_choice: 'auto', // Let the AI decide if a tool is needed
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

        for (const toolCall of message.tool_calls) {
          // --- Type Narrowing: only handle "function" type tool calls ---
          if (toolCall.type !== 'function') {
            console.warn(`⚠️ Skipping unsupported tool call type: ${toolCall.type}`);
            continue;
          }
        
           funcName = toolCall.function.name;
          let funcArgs: any;
          let toolResultContent: string;
        
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

            console.log("funcName >> ",funcName)

              // Parse the result safely
              let toolData: any = {};
              try {
                toolData = typeof result?.content?.[0]?.text === 'string'
                  ? JSON.parse(result.content[0].text)
                  : result?.content?.[0]?.text || result || {};
              } catch {}


              console.log("toolData",toolData?.updateCart?.cart);
              console.log("toolDatawhole >>",toolData);



              // --- Update sessionState ---
              if (!this.sessionState[sessionId]) this.sessionState[sessionId] = {};



              if(toolData?.updateCart?.cart?.clientInformation?.email){
                this.sessionState[sessionId].clientEmail =
                toolData?.updateCart?.cart?.clientInformation?.email || 'guest@example.com';
              }
              if(toolData?.addCartSelectedBookableItem?.cart?.summary?.total || toolData?.updateCart?.cart?.summary?.total){
                this.sessionState[sessionId].totalAmount = toolData?.addCartSelectedBookableItem ? toolData?.addCartSelectedBookableItem?.cart?.summary?.total/100 : toolData?.updateCart?.cart?.summary?.total/100;
              }

                
                console.log("addcartselecteditem",toolData?.addCartSelectedBookableItem?.cart);
                console.log("thistotalAmount", this.sessionState[sessionId].totalAmount);
                


              // Capture Cart ID from tool output
              if (toolData.cartId || toolData?.updateCart?.cart?.id) this.sessionState[sessionId].cartId = toolData?.cartId ?? toolData?.updateCart?.cart?.id;

              // Capture other critical IDs if present
              if (toolData.selectedItems?.length) {
                const item = toolData.selectedItems[0];
                if (item.id) this.sessionState[sessionId].serviceItemId = item.id;
                if (item.staffVariantId) this.sessionState[sessionId].staffVariantId = item.staffVariantId;
              }
              if (toolData.selectedBookableItem?.id) {
                this.sessionState[sessionId].bookableTimeId = toolData.selectedBookableItem.id;
              }



            // --- Extract and stringify result for LLM context ---
            toolResultContent = result?.content?.[0]?.text || '{}';

            console.log(`✅ Tool ${funcName} executed}`);


            if (funcName === 'createAppointmentCart') {
              const cartId = toolData?.createCart?.cart?.id;
              if (cartId) {
                
                // Ensure the session object exists
                if (!this.sessionState[sessionId]) {
                  this.sessionState[sessionId] = {};
                }
            
                this.sessionState[sessionId].cartId = cartId;
              } else {
                console.warn('⚠️ createAppointmentCart did not return a valid cart ID.');
              }
            }
            

          } catch (error: any) {
            // --- Handle tool call or execution errors gracefully ---
            console.error(`❌ Tool ${funcName} failed:`, error.message);
        
            toolResultContent = JSON.stringify({
              error: `Function ${funcName} failed or returned invalid data.`,
              details: error.message,
              parametersUsed: funcArgs,
            });
          }
        
          // --- Send result back to OpenAI as a "tool" role message ---
         // setTimeout(()=>{
            this.conversationHistory[sessionId].push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: toolResultContent,
            });
          //},500)
          
        }
        
        // Loop again: The next iteration will allow the AI to read the tool result and decide the next step (another tool or final text reply)
      } else {
        // --- AI responds with final text ---
        let  parsed:any = message;
        this.conversationHistory[sessionId].push(message);
        if (funcName === 'setClientOnCart') {
          

          console.log("thistotalAmount2", this.sessionState[sessionId]);
          

          //  try {
               parsed = message;//JSON.parse(toolResultContent || '{}');
              parsed.frontendAction = {
                type: 'SHOW_PAY_BUTTON',
                checkoutUrl: `https://blvd-chatbot.ostlive.com/checkout?email=${this.sessionState[sessionId].clientEmail}&amount=${this.sessionState[sessionId].totalAmount}`
              };
             // toolResultContent = JSON.stringify(parsed);
            //  console.log('💳 Added frontendAction to toolResultContent',toolResultContent);
            // } catch (err) {
            //   console.error('❌ Failed to parse toolResultContent as JSON:', err);
            // }
          }
        console.log('🗣️ LLM replied with text. End of turn.',message);
        return { reply: parsed };
      }
    }

    // Safety fallback if the loop limit is reached
    return { reply: { role: 'assistant', content: 'I seem to be stuck in a complex sequence. Could you please simplify your request or state the detail you want to change?' } };
  }


  private detectIntentFromUserMessage(message: string){
    const lower = message.toLowerCase();

    return 'giftcard';
  
    if (lower.includes('membership') || lower.includes('member') || lower.includes('package') || lower.includes('plan')) {
      return 'membership';
    }
    if (lower.includes('book') || lower.includes('appointment') || lower.includes('service') || lower.includes('schedule')) {
      return 'booking';
    }
  
    // default to booking if unsure
    return null;
  }
  
}
