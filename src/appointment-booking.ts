import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "cross-fetch";
import * as crypto from "crypto";

if (!process.env.URL_CLIENT ||
    !process.env.URL_ADMIN ||
    !process.env.BLVD_API_KEY ||
    !process.env.BLVD_BUSINESS_ID ||
    !process.env.BLVD_API_SECRET) {
    const dotenv = await import('dotenv');
    dotenv.config();
}
const { URL_CLIENT, URL_ADMIN, BLVD_API_KEY, BLVD_BUSINESS_ID, BLVD_API_SECRET } = process.env;

const server = new McpServer({
    name: "blvd-enterprise",
    version: "1.0.0",
    capabilities: { resources: {}, tools: {} },
});

async function generate_guest_auth_header(api_key: string) {
    const payload = `${api_key}:`;
    return Buffer.from(payload, "utf8").toString("base64");
}

async function generate_admin_auth_header() {
    const prefix = "blvd-admin-v1";
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = `${prefix}${BLVD_BUSINESS_ID}${timestamp}`;
    if (!BLVD_API_SECRET) throw new Error("Missing BLVD_API_SECRET");
    if (!BLVD_API_KEY) throw new Error("Missing BLVD_API_KEY");
    if (!BLVD_BUSINESS_ID) throw new Error("Missing BLVD_BUSINESS_ID");
    const raw_key = Buffer.from(BLVD_API_SECRET, "base64");
    const signature = crypto.createHmac("sha256", raw_key).update(payload, "utf8").digest("base64");
    const token = `${signature}${payload}`;
    const http_basic_payload = `${BLVD_API_KEY}:${token}`;
    return Buffer.from(http_basic_payload, "utf8").toString("base64");
}

async function gql(query: string, requestType: 'CLIENT'|'ADMIN', variables: any = {}, timeoutMs = 8000) {
    let API = '';
    let authenticationHeader = '';
    if (requestType === 'CLIENT') {
        if (!URL_CLIENT) throw new Error("Missing URL_CLIENT");
        if (!BLVD_API_KEY) throw new Error("Missing BLVD_API_KEY");
        API = URL_CLIENT!;
        authenticationHeader = await generate_guest_auth_header(BLVD_API_KEY);
    
        console.log(authenticationHeader);
    
      }
    else if (requestType == 'ADMIN') {
        if (!URL_ADMIN)
            throw new Error("Missing required env: URL_ADMIN");
        API = URL_ADMIN;
        authenticationHeader = await generate_admin_auth_header();

        console.log(authenticationHeader);
        
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(API, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${authenticationHeader}`
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
    });
    clearTimeout(timeout);
    const json = await res.json();
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors));
    return json.data;
}

/* --- GraphQL queries/mutations --- */
const GQL_LOCATIONS = `{
  locations(first:20){
    edges{
      node{
          id
          businessName
          contactEmail
          externalId
          allowOnlineBooking
          name
          address{
              city
              country
              line1
              line2
              province
              state
              zip
          }
    }
  }
}}`;
const CREATE_CART = `mutation createCart($input:CreateCartInput!){
      createCart(input:$input){
          cart{
            id
            clientMessage
            expiresAt
            features{
              bookingQuestionsEnabled
              giftCardPurchaseEnabled
              paymentInfoRequired
              serviceAddonsEnabled
            }
            summary{
              deposit
              depositAmount
              discountAmount
              gratuityAmount
              paymentMethodRequired
              roundingAmount
              subtotal
              taxAmount
              total
            }
            bookingQuestions{
              id
              key
              label
              required
            }
            clientInformation{
              email
              firstName
              lastName
              phoneNumber
              externalId
            }
            location{
              id
              name
              address {
                city
                country
                line1
                line2
                state
              }
              businessName
            }
          }
      }
  }`;
const AVAILABLE_SERVICES = `query serviceList($id:ID!){
    cart(id:$id){
        availableCategories{
            id
            name
            availableItems{
                id
                name
                description
                listPrice
                listPriceRange{
                    min
                    max
                    variable
                }
            }
        }
    }
}`;


const ADD_SERVICE_TO_CART = `
  mutation addCartSelectedBookableItem($input: AddCartSelectedBookableItemInput!) {
    addCartSelectedBookableItem(input: $input) {
      cart {
        id
        expiresAt
        selectedItems {
          id
          price
          ... on CartBookableItem {
            item {
              id
              name
              optionGroups {
                id
                name
              }
            }
            guest {
              email
              firstName
              id
              label
              lastName
              number
              phoneNumber
            }
            guestId
            selectedOptions {
              id
              name
              priceDelta
              groupId
              durationDelta
              description
            }
          }
          addons {
            id
            name
            description
            disabled
            disabledDescription
            listPrice
            listPriceRange {
              min
              max
              variable
            }
            ... on CartAvailableBookableItem {
              optionGroups {
                id
                name
                description
                options {
                  id
                  name
                  description
                  durationDelta
                  priceDelta
                }
              }
            }
          }
          item {
            id
            name
            description
            disabled
            disabledDescription
          }
        }
        summary {
          deposit
          depositAmount
          discountAmount
          gratuityAmount
          paymentMethodRequired
          roundingAmount
          subtotal
          taxAmount
          total
        }
        bookingQuestions {
          id
          key
          label
          required
        }
        clientInformation {
          email
          firstName
          lastName
          phoneNumber
          externalId
        }
        location {
          id
          name
          businessName
        }
      }
    }
  }
`;



const CART_BOOKABLE_DATES = `query cartBookableDates($id:ID!, $searchRangeLower:Date, $searchRangeUpper:Date){
      cartBookableDates(id:$id, searchRangeLower:$searchRangeLower, searchRangeUpper:$searchRangeUpper){
          date
      }
    }
`;
const CART_BOOKABLE_TIMES = `query cartBookableTimes($id:ID!, $searchDate:Date!){
      cartBookableTimes(id:$id  searchDate:$searchDate){
        id
        businessName
        contactEmail
        externalId
        allowOnlineBooking
        name
        address{ city country line1 line2 province state zip }
      }
    }
  }
}`;

const CREATE_CART = `mutation createCart($input:CreateCartInput!){
  createCart(input:$input){ cart { id clientMessage expiresAt location{ id name businessName } } }
}`;

const AVAILABLE_SERVICES = `query serviceList($id:ID!){
  cart(id:$id){
    availableCategories{
      id
      name
      availableItems{ id name description listPrice }
    }
  }
}`;

const ADD_SERVICE_TO_CART = `mutation addCartSelectedBookableItem($input:AddCartSelectedBookableItemInput!){
  addCartSelectedBookableItem(input:$input){ cart { id } }
}`;

const CART_BOOKABLE_DATES = `query cartBookableDates($id:ID!, $locationId:ID, $searchRangeLower:Date, $searchRangeUpper:Date){
  cartBookableDates(id:$id, locationId:$locationId, searchRangeLower:$searchRangeLower, searchRangeUpper:$searchRangeUpper){
    date
  }
}`;

const CART_BOOKABLE_TIMES = `query cartBookableTimes($id:ID!, $searchDate:Date!, $locationId:ID, $serviceId:ID){
  cartBookableTimes(id:$id, searchDate:$searchDate, locationId:$locationId, serviceId:$serviceId){
    id
    score
    startTime
  }
}`;

const RESERVE_CART_BOOKABLE_ITEMS = `mutation reserveCartBookableItems($input:AddCartSelectedBookableItemInput!){
  reserveCartBookableItems(input:$input){ cart { id expiresAt } }
}`;

const SET_CLIENT_ON_CART = `mutation updateCart($input:UpdateCartInput!){
  updateCart(input:$input){ cart { id clientInformation{ email firstName lastName phoneNumber } } }
}`;

server.tool("get_locations", "Get available locations for the business", async () => {
  const data = await gql(GQL_LOCATIONS, 'CLIENT', { businessId: BLVD_BUSINESS_ID }, 7000);
  const locations = data?.locations?.edges?.map(e => ({
    id: e?.node?.id,
    name: e?.node?.name || e?.node?.businessName,
    city: e?.node?.address?.city,
  })) ?? [];
  
  
  console.error("[MCP SERVER] has returned locations:", locations);

  return { content: [{ type: "text", text: JSON.stringify({ locations }) }] };
});
    


server.tool("availableServices", "Get available services", {
    cartId: z.string().describe("cart id"),
}, async ({ cartId }) => {
  
    const data = await gql(AVAILABLE_SERVICES, 'CLIENT', { id: cartId });
  
  
    // console.error("available services:", JSON.stringify(data, null, 2));  // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});


server.tool("createAppointmentCart", "Create a cart scoped to a business/location for appointment booking", {
    locationId: z.string().describe("location id"),
}, async ({ locationId }) => {
    const data = await gql(CREATE_CART, 'CLIENT', { input: { locationId: locationId } });
    // const locations = data?.locations?.edges ?? [];
   
    console.error(data);
    console.error(locationId);
   
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});



server.tool("addServiceToCart", "Add a service to an existing cart", {
  cartId: z.string().describe("existing cart id"),
  serviceId: z.string().optional().describe("existing service id"),
  serviceName: z.string().optional().describe("service name (e.g. 'Classic and Hydra Facial')"),
}, async ({ cartId, serviceId, serviceName }) => {

  console.error("🛠 addServiceToCart →", { cartId, serviceId, serviceName });

  // If serviceName provided, resolve to ID
  if (!serviceId && serviceName) {
    console.log(`Resolving service name "${serviceName}" to ID...`);
    const servicesData = await gql(AVAILABLE_SERVICES, 'CLIENT', { id: cartId });

    const allServices = servicesData?.cart?.availableCategories?.flatMap(c => c.availableItems) || [];
    const match :any= fuzzyMatch(serviceName, allServices);

    if (!match) {
      return {
        content: [
          { type: "text", text: `❌ Service "${serviceName}" not found in available services.` }
        ]
      };
    }

    serviceId = match.id!;
    console.log(`✅ Matched service "${serviceName}" → ${serviceId}`);
  }

  if (!serviceId) {
    return {
      content: [
        { type: "text", text: `❌ Missing both serviceId and serviceName.` }
      ]
    };
  }

  // Proceed with booking
  const data = await gql(ADD_SERVICE_TO_CART, 'CLIENT', {
    input: { id: cartId, itemId: serviceId }
  });

  console.log(`🧾 Added serviceId: ${serviceId}`);

  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});


server.tool("cartBookableDates", "First 15 bookable dates for the cart", {
    cartId: z.string().describe("existing cart id"),
    searchRangeLower: z.string().describe("lower range date in format YYYY-MM-DD"),
    searchRangeUpper: z.string().describe("upper range date in format YYYY-MM-DD"),
}, async ({ cartId, searchRangeLower, searchRangeUpper }) => {
    
  
  const data = await gql(CART_BOOKABLE_DATES, 'CLIENT', {
        "id": cartId,
        "searchRangeLower": searchRangeLower,
        "searchRangeUpper": searchRangeUpper
    });
    
    // Expecting data.cartBookableDates to be an array of {date: string}
    const dates = (data?.cartBookableDates || []).map(d => d.date).slice(0, 15);
    
    
    return { content: [{ type: "text", text: JSON.stringify(dates) }] };
});

server.tool("cartBookableTimes", "First 15 available times for the cart and date as array of slot objects", {
    cartId: z.string().describe("existing cart id"),
    searchDate: z.string().describe("search date in format YYYY-MM-DD"),
}, async ({ cartId, searchDate }) => {
    const data = await gql(CART_BOOKABLE_TIMES, 'CLIENT', {
        "id": cartId,
        "searchDate": searchDate,
    });
    // Return the full slot objects with id and startTime
    const slots = (data?.cartBookableTimes || []).slice(0, 15);
    return { content: [{ type: "text", text: JSON.stringify(slots) }] };
});
server.tool("reserveCartBookableItems", "set and reserve bookable time for cart", {
    cartId: z.string().describe("existing cart id"),
    bookableTimeId: z.string().describe("bookable time id"),
}, async ({ cartId, bookableTimeId }) => {
    const data = await gql(RESERVE_CART_BOOKABLE_ITEMS, 'CLIENT', { input: {
            "id": cartId,
            "bookableTimeId": bookableTimeId
        } });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});



server.tool(
  "getCartSummary",
  {
    cartId: z.string().describe("Existing cart ID"),
  },
  async ({ cartId }) => {
    console.log("🧾 MCP → getCartSummary called with:", cartId);

    const data = await gql(GET_CART_SUMMARY, "CLIENT", { id: cartId });
    const cart = data?.cart;

    if (!cart) {
      return {
        content: [
          {
            type: "text",
            text: "Cart not found or expired.",
          },
        ],
      };
    }

    // ✅ Simply return the backend response as-is
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(cart),
        },
      ],
    };
  }
);




function formatAmount(value?: number | null): string {
  if (!value) return "0.00";
  return (value / 100).toFixed(2);
}




server.tool(
  "updateCartSelectedBookableItem",
  "Update a cart's selected bookable item details (guest, options, staff variant).",
  {
    cartId: z.string().describe("Cart ID"),
    itemId: z.string().describe("Service Item ID"),
    itemStaffVariantId: z.string().optional().describe("Staff variant ID (optional)"),
    itemGuestId: z.string().optional().describe("Guest ID (optional)"),
    itemOptionIds: z.array(z.string()).optional().describe("List of selected option IDs (optional)"),
    clientId: z.string().optional().describe("Client ID (optional)"),
  },
  async ({ cartId, itemId, itemStaffVariantId, itemGuestId, itemOptionIds, clientId }) => {
    try {
      const mutation = `
        mutation updateCartSelectedBookableItem($input: AddCartSelectedBookableItemInput!) {
          updateCartSelectedBookableItem(input: $input) {
            cart {
              id
              expiresAt
              selectedItems {
                id
                price
                ...on CartBookableItem {
                  selectedOptions {
                    id
                    name
                    priceDelta
                    groupId
                    durationDelta
                    description
                  }
                }
                addons {
                  id
                  name
                  description
                  disabled
                  disabledDescription
                  listPrice
                  listPriceRange {
                    min
                    max
                    variable
                  }
                  ...on CartAvailableBookableItem {
                    optionGroups {
                      id
                      name
                      description
                      options {
                        id
                        name
                        description
                        durationDelta
                        priceDelta
                      }
                    }
                  }
                }
                item {
                  id
                  name
                  description
                  disabled
                  disabledDescription
                }
              }
              summary {
                deposit
                depositAmount
                discountAmount
                gratuityAmount
                paymentMethodRequired
                roundingAmount
                subtotal
                taxAmount
                total
              }
              bookingQuestions {
                id
                key
                label
                required
              }
              clientInformation {
                email
                firstName
                lastName
                phoneNumber
                externalId
              }
              location {
                id
                name
                businessName
              }
            }
          }
        }
      `;

      const variables = {
        input: {
          id: cartId,
          itemId,
          itemGuestId,
          itemOptionIds,
          itemStaffVariantId,
        },
      };

      // 🧠 Call your GraphQL helper (gql or fetchRequest)
      const data = await gql(mutation, "CLIENT", variables);

      console.log("🧩 [updateCartSelectedBookableItem] success:", data);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data?.updateCartSelectedBookableItem ?? {}, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error("❌ [updateCartSelectedBookableItem] failed:", error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              message: error?.message || "Unknown error",
            }),
          },
        ],
      };
    }
  }
);




server.tool(
  "cartBookableStaffVariants",
  "Fetch available estheticians (staff) for a selected service time.",
  {
    id: z.string().describe("Cart ID"),
    itemId: z.string().describe("existing Item ID"),
    bookableTimeId: z.string().describe("Selected bookable time ID"),
  },
  async ({ id, itemId, bookableTimeId }) => {
    const query = `
      query CartBookableStaffVariants($id: ID!, $itemId: ID!, $bookableTimeId: ID!) {
        cartBookableStaffVariants(id: $id, itemId: $itemId, bookableTimeId: $bookableTimeId) {
          id
          duration
          price
          staff {
            id
            displayName
            firstName
            lastName
            bio
            role { id name }
          }
        }
      }
    `;

    const variables = { id, itemId, bookableTimeId };

    console.error("id", id);
    console.error("itemId", itemId);
    console.error("bookableTimeId", bookableTimeId);


    try {
      console.error("🧠 [MCP SERVER] Fetching staff variants with:", variables);

      const result = await gql(query, "CLIENT", variables);

      console.error("✅ [MCP SERVER] Staff variants fetched successfully.");
      console.error("📦 [MCP SERVER] Raw result:", JSON.stringify(result, null, 2));

      console.error(" result", result);


      const staffVariants = result?.cartBookableStaffVariants ?? [];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(staffVariants, null, 2),
          },
        ],
      };
    } catch (error: any) {
      console.error("❌ [MCP SERVER] cartBookableStaffVariants failed!");
      console.error("Error message:", error?.message || error);
      console.error("Stack trace:", error?.stack || "No stack trace available");

      // Return error as MCP content so client side can also log it
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              message: error?.message || "Unknown error occurred while fetching staff variants",
            }),
          },
        ],
      };
    }
  }
);








server.tool("checkAvailability", "Check availability for a given service and date/time", {
  cartId: z.string().describe("existing cart id"),
  serviceId: z.string().describe("service id"),
  date: z.string().optional().describe("date in format YYYY-MM-DD"),
  time: z.string().optional().describe("time in format HH:MM or 12-hour format with AM/PM"),
}, async ({ cartId, serviceId, date, time }) => {
  console.log(`[checkAvailability] checking`, { cartId, serviceId, date, time });
  
  try {
    // First, check if service is already in cart or add it
    if (serviceId) {
      try {
        await gql(ADD_SERVICE_TO_CART, 'CLIENT', {
          input: {
            id: cartId,
            itemId: serviceId
          }
        }, 7000);
      } catch (err) {
        // Service might already be in cart, continue
        console.log('Service might already be in cart:', err);
      }
    }
    
    if (!date) {
      // Get available dates for the next 30 days
      const today = new Date();
      const rangeLower = today.toISOString().split('T')[0];
      const rangeUpper = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const availableDates = await gql(CART_BOOKABLE_DATES, 'CLIENT', {
        id: cartId,
        searchRangeLower: rangeLower,
        searchRangeUpper: rangeUpper
      }, 7000);
      
      return {
        content: [
          {
            type: "text",
            text: `📅 **Available dates for the next 30 days:**\n\n${JSON.stringify(availableDates?.cartBookableDates || [], null, 2)}`
          }
        ]
      };
    }
    
    const searchDate = new Date(date + 'T00:00:00Z').toISOString();
    
    // Check available times for the specified date
    const availableTimes = await gql(CART_BOOKABLE_TIMES, 'CLIENT', {
      id: cartId,
      searchDate: searchDate
    }, 7000);
    
    if (!time) {
      // Return all available times for the date
      return {
        content: [
          {
            type: "text",
            text: `🕐 **Available times for ${date}:**\n\n${JSON.stringify(availableTimes?.cartBookableTimes || [], null, 2)}`
          }
        ]
      };
    }
    
    // Check if the specific time is available
    const times = availableTimes?.cartBookableTimes || [];
    const requestedTime = time.toLowerCase().trim();
    
    // Simple matching logic - look for similar times
    const isAvailable = times.some(t => {
      const bellTime = t.startTime?.toLowerCase() || '';
      return bellTime.includes(requestedTime) || requestedTime.includes(bellTime.split(':')[0]);
    });
    
    if (isAvailable) {
      return {
        content: [
          {
            type: "text",
            text: `✅ **Slot available on ${date} at ${time}!** Proceeding with booking...`
          }
        ]
      };
    } else {
      return {
        content: [
          {
            type: "text",
            text: `❌ Slot not available on ${date} at ${time}. Here are the available times for that date:\n\n${JSON.stringify(times.map(t => t.startTime), null, 2)}`
          }
        ]
      };
    }
    
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `Error checking availability: ${err.message}\n\nDetails: ${JSON.stringify(err, null, 2)}`
        }
      ]
    };
  }
});


server.tool("setClientOnCart", "Attach client info to the cart before checkout", {
    cartId: z.string().describe("existing cart id"),
    firstName: z.string().describe("User first name"),
    lastName: z.string().describe("User last name"),
    email: z.string().describe("User email"),
    phoneNumber: z.string().describe("user phone number")
}, async ({ cartId, firstName, lastName, email, phoneNumber }) => {
    const data = await gql(SET_CLIENT_ON_CART, 'CLIENT', { input: {
            "id": cartId,
            "clientInformation": { firstName, lastName, email, phoneNumber }
        } });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});
server.tool("applyPromotionCode", "Apply a promo/discount code to the cart (optional)", {
    cartId: z.string().describe("existing cart id"),
    offerCode: z.string().describe("promotion code")
}, async ({ cartId, offerCode }) => {
    const data = await gql(APPLY_PROMOTION_CODE, 'CLIENT', { input: {
            "id": cartId,
            "offerCode": offerCode
        } });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});
server.tool("tokenizeCard", "Tokenize a credit card via Boulevard Vault sandbox (https://vault-sandbox.joinblvd.com/cards/tokenize)", {
    name: z.string().describe("Cardholder full name"),
    number: z.string().describe("Card number (PAN)"),
    cvv: z.string().describe("Card CVV/CVC"),
    exp_month: z.number().describe("Expiry month (1–12)"),
    exp_year: z.number().describe("Expiry year (2-digit or 4-digit)"),
    address_postal_code: z.string().describe("Billing postal / ZIP code"),
}, async ({ name, number, cvv, exp_month, exp_year, address_postal_code }) => {
    try {
        // Convert 2-digit year to 4-digit if needed
        if (exp_year < 100)
            exp_year = 2000 + exp_year;
        const payload = {
            card: {
                name,
                number,
                cvv,
                exp_month,
                exp_year,
                address_postal_code,
            },
        };
        const response = await fetch("https://vault-sandbox.joinblvd.com/cards/tokenize", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/plain, */*",
                "User-Agent": "blvd-enterprise-app/1.0",
            },
            body: JSON.stringify(payload),
        });
        const json = await response.json();
        // Return exactly what Vault returns
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(json, null, 2),
                },
            ],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ success: false, error: String(err) }, null, 2),
                },
            ],
        };
    }
});
const ADD_CART_CARD_PAYMENT_METHOD = `
mutation addCartCardPaymentMethod($input: AddCartCardPaymentMethodInput!) {
  addCartCardPaymentMethod(input: $input) {
    cart { id availablePaymentMethods { id name __typename } }
  }
}
`;

const CHECKOUT_CART = `
mutation checkoutCart($id: ID!) {
  checkoutCart(input: { id: $id }) {
    appointments { appointmentId clientId forCartOwner }
    cart { id startTime clientInformation { email firstName lastName } }
  }
}
`;

/* --- Tools registration --- */
server.tool("get_locations", "Get available locations for the business", async () => {
    const data = await gql(GQL_LOCATIONS, 'CLIENT', {});
    const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(locations) }] };
});

server.tool("availableServices", "Get available services", { cartId: z.string().describe("cart id") }, async ({ cartId }) => {
    const data = await gql(AVAILABLE_SERVICES, 'CLIENT', { id: cartId });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

server.tool("createAppointmentCart", "Create a cart scoped to a business/location", { locationId: z.string().describe("location id") }, async ({ locationId }) => {
    const data = await gql(CREATE_CART, 'CLIENT', { input: { locationId } });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

server.tool("addServiceToCart", "Add a service to an existing cart", {
    cartId: z.string().describe("cart id"),
    serviceId: z.string().describe("service id")
}, async ({ cartId, serviceId }) => {
    const data = await gql(ADD_SERVICE_TO_CART, 'CLIENT', { input: { id: cartId, itemId: serviceId } });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

/* cartBookableDates — server side expects dates as YYYY-MM-DD (GraphQL Date) */
server.tool("cartBookableDates", "Bookable dates for the cart", {
    cartId: z.string().describe("cart id"),
    locationId: z.string().describe("location id"),
    searchRangeLower: z.string().describe("lower range date YYYY-MM-DD"),
    searchRangeUpper: z.string().describe("upper range date YYYY-MM-DD"),
}, async ({ cartId, locationId, searchRangeLower, searchRangeUpper }) => {
    const data = await gql(CART_BOOKABLE_DATES, 'CLIENT', {
        id: cartId,
        locationId,
        searchRangeLower,
        searchRangeUpper
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

/* cartBookableTimes — fixed GraphQL (proper args) */
server.tool("cartBookableTimes", "Bookable times for the cart", {
    cartId: z.string().describe("cart id"),
    locationId: z.string().describe("location id"),
    serviceId: z.string().describe("service id"),
    searchDate: z.string().describe("date YYYY-MM-DD"),
}, async ({ cartId, locationId, serviceId, searchDate }) => {
    const data = await gql(CART_BOOKABLE_TIMES, 'CLIENT', {
        id: cartId,
        searchDate,
        locationId,
        serviceId
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

server.tool("reserveCartBookableItems", "Reserve a bookable time", {
    cartId: z.string().describe("cart id"),
    bookableTimeId: z.string().describe("bookable time id"),
}, async ({ cartId, bookableTimeId }) => {
    const data = await gql(RESERVE_CART_BOOKABLE_ITEMS, 'CLIENT', { input: { id: cartId, bookableTimeId } });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

server.tool("checkAvailability", "Check availability for a given service and date/time", {
  cartId: z.string().describe("cart id"),
  serviceId: z.string().describe("service id"),
  date: z.string().optional().describe("date YYYY-MM-DD"),
  time: z.string().optional().describe("time HH:MM or 12-hour format")
}, async ({ cartId, serviceId, date, time }) => {
  try {
    // ensure service in cart
    if (serviceId) {
      try {
        await gql(ADD_SERVICE_TO_CART, 'CLIENT', { input: { id: cartId, itemId: serviceId } }, 7000);
      } catch (e) {
        // ignore if already present
      }
    }

    if (!date) {
      const today = new Date();
      const rangeLower = today.toISOString().split('T')[0];
      const rangeUpper = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const availableDates = await gql(CART_BOOKABLE_DATES, 'CLIENT', { id: cartId, searchRangeLower: rangeLower, searchRangeUpper: rangeUpper }, 7000);
      return { content: [{ type: "text", text: JSON.stringify(availableDates?.cartBookableDates || []) }] };
    }

    const availableTimes = await gql(CART_BOOKABLE_TIMES, 'CLIENT', { id: cartId, searchDate: date, locationId: null, serviceId }, 7000);
    if (!time) {
      return { content: [{ type: "text", text: JSON.stringify(availableTimes?.cartBookableTimes || []) }] };
    }

    const times = availableTimes?.cartBookableTimes || [];
    const requested = time.toLowerCase();
    const isAvailable = times.some((t: any) => (t.startTime || '').toLowerCase().includes(requested));

    if (isAvailable) {
      return { content: [{ type: "text", text: `✅ Slot available on ${date} at ${time}` }] };
    } else {
      return { content: [{ type: "text", text: `❌ Not available. Options: ${JSON.stringify(times.map((t:any)=>t.startTime))}` }] };
    }
  } catch (err:any) {
    return { content: [{ type: "text", text: `Error: ${String(err)}` }] };
  }
});

server.tool("setClientOnCart", "Attach client info", {
    cartId: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phoneNumber: z.string(),
}, async ({ cartId, firstName, lastName, email, phoneNumber }) => {
    const data = await gql(SET_CLIENT_ON_CART, 'CLIENT', { input: { id: cartId, clientInformation: { firstName, lastName, email, phoneNumber } } });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

server.tool("applyPromotionCode", "Apply promo", { cartId: z.string(), offerCode: z.string() }, async ({ cartId, offerCode }) => {
    const data = await gql(APPLY_PROMO, 'CLIENT', { input: { id: cartId, offerCode } });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

server.tool("tokenizeCard", "Tokenize card (vault)", {
    name: z.string(), number: z.string(), cvv: z.string(), exp_month: z.number(), exp_year: z.number(), address_postal_code: z.string()
}, async ({ name, number, cvv, exp_month, exp_year, address_postal_code }) => {
    try {
        if (exp_year < 100) exp_year = 2000 + exp_year;
        const payload = { card: { name, number, cvv, exp_month, exp_year, address_postal_code } };
        const response = await fetch("https://vault-sandbox.joinblvd.com/cards/tokenize", { method: "POST", headers: { "Content-Type":"application/json", "User-Agent":"blvd-enterprise-app/1.0" }, body: JSON.stringify(payload) });
        const json = await response.json();
        return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    } catch (err:any) {
        return { content: [{ type: "text", text: JSON.stringify({ success:false, error:String(err) }) }] };
    }
});

server.tool("addCartCardPaymentMethod", "Attach card to cart", {
    cartId: z.string(), token: z.string(), select: z.boolean().optional()
}, async ({ cartId, token, select }) => {
    try {
        const variables = { input: { id: cartId, token, select: select ?? true } };
        const data = await gql(ADD_CART_CARD_PAYMENT_METHOD, "CLIENT", variables);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err:any) {
        return { content: [{ type: "text", text: JSON.stringify({ success:false, error:String(err) }) }] };
    }
});

server.tool("checkoutCart", "Checkout cart", { cartId: z.string() }, async ({ cartId }) => {
    try {
        const data = await gql(CHECKOUT_CART, "CLIENT", { id: cartId });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err:any) {
        return { content: [{ type: "text", text: JSON.stringify({ success:false, error:String(err) }) }] };
    }
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("BLVD ENTERPRISE Appointment Booking MCP Server running on stdio");
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});