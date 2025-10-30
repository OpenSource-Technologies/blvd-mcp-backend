import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "cross-fetch";
import * as crypto from "crypto";
// let envLoaded = false;
// try {
//   const dotenv = await import('dotenv');
//   dotenv.config();
//   envLoaded = true;
// } catch {
//   // console.log("dotenv not available; using Claude-provided environment");
// }
if (!process.env.URL_CLIENT ||
    !process.env.URL_ADMIN ||
    !process.env.BLVD_API_KEY ||
    !process.env.BLVD_BUSINESS_ID ||
    !process.env.BLVD_API_SECRET) {
    const dotenv = await import('dotenv');
    dotenv.config();
}
const { URL_CLIENT, URL_ADMIN, BLVD_API_KEY, BLVD_BUSINESS_ID, BLVD_API_SECRET } = process.env;
// const BLVD_API = "https://dashboard.boulevard.io/api/2020-01/c869f2d0-d72f-4466-9da8-1a14398ed1af/client"; // example endpoint; confirm for your app
// const { BLVD_API_KEY, BLVD_BUSINESS_ID } = process.env;
// const URL_CLIENT = "https://dashboard.boulevard.io/api/2020-01/c869f2d0-d72f-4466-9da8-1a14398ed1af/client";
// const URL_ADMIN = "https://dashboard.boulevard.io/api/2020-01/admin";
// const { BLVD_API_KEY, BLVD_BUSINESS_ID, BLVD_API_SECRET } = {"BLVD_API_KEY": 'd6764d76-d884-4ab5-87c1-90befe969ef4', "BLVD_BUSINESS_ID":'c869f2d0-d72f-4466-9da8-1a14398ed1af', 'BLVD_API_SECRET':"uyjdGShwGICFKbr8TtXiyM8B++nigR+i1XFJi6b1FT8="};
// const USER_AGENT = "blvd-enterprise-app/1.0";
// Create server instance
const server = new McpServer({
    name: "blvd-enterprise",
    version: "1.0.0",
    capabilities: {
        resources: {},
        tools: {},
    },
});
async function generate_guest_auth_header(api_key) {
    const payload = `${api_key}:`;
    const http_basic_credentials = Buffer.from(payload, "utf8").toString("base64");
    return http_basic_credentials;
}
async function generate_admin_auth_header() {
    const prefix = "blvd-admin-v1";
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = `${prefix}${BLVD_BUSINESS_ID}${timestamp}`;
    if (!BLVD_API_SECRET)
        throw new Error("Missing required env: BLVD_API_SECRET");
    if (!BLVD_API_KEY)
        throw new Error("Missing required env: BLVD_API_KEY");
    if (!BLVD_BUSINESS_ID)
        throw new Error("Missing required env: BLVD_BUSINESS_ID");
    let raw_key;
    try {
        raw_key = Buffer.from(BLVD_API_SECRET, "base64");
    }
    catch {
        throw new Error("BLVD_API_SECRET must be a base64-encoded string");
    }
    const signature = crypto
        .createHmac("sha256", raw_key)
        .update(payload, "utf8")
        .digest("base64");
    const token = `${signature}${payload}`;
    const http_basic_payload = `${BLVD_API_KEY}:${token}`;
    const http_basic_credentials = Buffer.from(http_basic_payload, "utf8").toString("base64");
    return http_basic_credentials;
}
async function gql(query, requestType, variables = {}, timeoutMs = 8000) {
    let API = '';
    let authenticationHeader = '';
    if (requestType == 'CLIENT') {
        if (!URL_CLIENT)
            throw new Error("Missing required env: URL_CLIENT");
        if (!BLVD_API_KEY)
            throw new Error("Missing required env: BLVD_API_KEY");
        API = URL_CLIENT!;
        authenticationHeader = await generate_guest_auth_header(BLVD_API_KEY);
    }
    else if (requestType == 'ADMIN') {
        if (!URL_ADMIN)
            throw new Error("Missing required env: URL_ADMIN");
        API = URL_ADMIN;
        authenticationHeader = await generate_admin_auth_header();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(API, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${authenticationHeader}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
    });
    clearTimeout(timeout);
    const json = await res.json();
    if (json.errors?.length)
        throw new Error(JSON.stringify(json.errors));
    return json.data;
}

// 🧠 Simple fuzzy matcher utility
function fuzzyMatch(userInput, services) {
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
  const input = normalize(userInput);

  // Score based on substring & similarity
  let bestMatch = null;
  let highestScore = 0;

  for (const svc of services) {
    const name = normalize(svc.name);
    let score = 0;

    if (name.includes(input)) score += 2;
    if (input.includes(name)) score += 2;

    // Character overlap similarity
    const overlap = [...new Set(input)].filter((c) => name.includes(c)).length;
    score += overlap / Math.max(name.length, input.length);

    if (score > highestScore) {
      highestScore = score;
      bestMatch = svc;
    }
  }

  return highestScore >= 1.5 ? bestMatch : null;
}


const GQL_LOCATIONS = /* GraphQL */ `{
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
const ADD_SERVICE_TO_CART = `mutation addCartSelectedBookableItem($input:AddCartSelectedBookableItemInput!){
      addCartSelectedBookableItem(input:$input){
        cart {
          id
        }
      }
    }`;
const CART_BOOKABLE_DATES = `query cartBookableDates($id:ID!, $searchRangeLower:Date, $searchRangeUpper:Date){
      cartBookableDates(id:$id, searchRangeLower:$searchRangeLower, searchRangeUpper:$searchRangeUpper){
          date
      }
    }
`;
const CART_BOOKABLE_TIMES = `query cartBookableTimes($id:ID!, $searchDate:Date!){
      cartBookableTimes(id:$id  searchDate:$searchDate){
        id
        score
        startTime
      }
    }
`;
const RESERVE_CART_BOOKABLE_ITEMS = `mutation reserveCartBookableItems($input:AddCartSelectedBookableItemInput!){
    reserveCartBookableItems(input:$input){
    cart{
        id
        expiresAt
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
        businessName
        }
    }
    }
}`;




const GET_CART_SUMMARY = `
query cart($id: ID!) {
  cart(id: $id) {
    id
    expiresAt
    selectedItems {
      id
      ... on CartBookableItem {
        item {
          id
          name
        }
        selectedStaffVariant {
          id
          duration
          price
          staff {
            displayName
          }
        }
      }
    }
    summary {
      subtotal
      taxAmount
      total
    }
    location {
      name
      businessName
    }
    clientInformation {
      firstName
      lastName
      email
      phoneNumber
    }
  }
}
`;


const SET_CLIENT_ON_CART = `mutation updateCart($input:UpdateCartInput!){
      updateCart(input:$input){
        cart{
          id
          clientMessage
          expiresAt
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
            businessName
          }
        }
      }
    }`;
const APPLY_PROMOTION_CODE = `mutation addCartOffer($input:AddCartOfferInput!){
      addCartOffer(input:$input){
        offer{
          applied
          code
          id
          name
        }
        cart{
          id
          completedAt
          expiresAt
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
            businessName
          }
        }
      }
    }`;

server.tool("get_locations", "Get available locations for the business", async () => {
  const data = await gql(GQL_LOCATIONS, 'CLIENT', { businessId: BLVD_BUSINESS_ID }, 7000);
  const locations = data?.locations?.edges?.map(e => ({
    id: e?.node?.id,
    name: e?.node?.name || e?.node?.businessName,
    city: e?.node?.address?.city,
  })) ?? [];
  return { content: [{ type: "text", text: JSON.stringify({ locations }) }] };
});
    


server.tool("availableServices", "Get available services", {
    cartId: z.string().describe("cart id"),
}, async ({ cartId }) => {
    const data = await gql(AVAILABLE_SERVICES, 'CLIENT', { id: cartId });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});


server.tool("createAppointmentCart", "Create a cart scoped to a business/location for appointment booking", {
    locationId: z.string().describe("location id"),
}, async ({ locationId }) => {
    const data = await gql(CREATE_CART, 'CLIENT', { input: { locationId: locationId } });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
});
server.tool("addServiceToCart", "Add a service to an existing cart", {
    cartId: z.string().describe("existing cart id"),
    serviceId: z.string().describe("service id")
}, async ({ cartId, serviceId }) => {
    const data = await gql(ADD_SERVICE_TO_CART, 'CLIENT', { input: {
            "id": cartId,
            "itemId": serviceId
        } });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
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

server.tool("cartBookableTimes", "First 15 available times for the cart and date as array of ISO strings", {
    cartId: z.string().describe("existing cart id"),
    searchDate: z.string().describe("search date in format YYYY-MM-DD"),
}, async ({ cartId, searchDate }) => {
    const data = await gql(CART_BOOKABLE_TIMES, 'CLIENT', {
        "id": cartId,
        "searchDate": searchDate,
    });
    // Expecting data.cartBookableTimes to be an array of {startTime: string}
    const slots = (data?.cartBookableTimes || []).map(s => s.startTime).slice(0, 15);
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
    cartId: z.string().describe("existing cart id"),
  },
  async ({ cartId }) => {
    
    
    const data = await gql(GET_CART_SUMMARY, "CLIENT", { id: cartId });

    const cart = data?.cart;

    console.log("MCP → getCartSummary called with:", cartId);
    console.log("cart details :", cart);

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

    const service =
      cart.selectedItems?.[0]?.item?.name || "Unknown service";
    const subtotal = cart.summary?.subtotal ?? 0;
    const taxAmount = cart.summary?.taxAmount ?? 0;
    const total = cart.summary?.total ?? 0;
    const location = cart.location?.name || "Unknown location";
    const clientName = `${cart.clientInformation?.firstName || ""} ${
      cart.clientInformation?.lastName || ""
    }`.trim();


  console.log(cart?.summary);
  const rawSubtotal = cart.summary?.subtotal ?? 0;
  const rawTax = cart.summary?.taxAmount ?? 0;
  const rawTotal = cart.summary?.total ?? 0;
  
  const payload = {
    cartId: cart.id,
    clientName: clientName || "N/A",
    location,
    service,
    raw: {
      subtotal: rawSubtotal,
      taxAmount: rawTax,
      total: rawTotal,
    },
    display: {
      subtotal: formatAmountMaybeCents(rawSubtotal),
      taxAmount: formatAmountMaybeCents(rawTax),
      total: formatAmountMaybeCents(rawTotal),
    },
    expiresAt: cart.expiresAt || null,
  };
  

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload),
        },
      ],
    };
  }
);



// helper for formatting cents -> dollars
function formatAmountMaybeCents(value) {
  if (value === null || value === undefined) return null;
  // if it's integer and looks like cents (divisible by 1 and large)
  if (Number.isInteger(value) && Math.abs(value) >= 100 && value % 1 === 0) {
    // If it's divisible by 100 -> treat as cents
    if (value % 100 === 0) {
      return (value / 100).toFixed(2);
    }
    // Otherwise still try /100 but with warning
    return (value / 100).toFixed(2);
  }
  // otherwise assume it's already dollars/float
  return Number(value).toFixed(2);
}



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
    cart {
      id
      expiresAt
      availablePaymentMethods {
        id
        name
        ... on CartItemCardPaymentMethod {
          cardBrand
          cardExpMonth
          cardExpYear
          cardHolder
          cardIsDefault
          cardLast4
          id
          name
          __typename
        }
        ... on CartItemVoucherPaymentMethod {
          availableCount
          expiresOn
          id
          name
          __typename
        }
        __typename
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
        __typename
      }
      clientInformation {
        email
        firstName
        lastName
        phoneNumber
        externalId
        __typename
      }
      __typename
    }
    __typename
  }
}
`;
server.tool("addCartCardPaymentMethod", "Attach a tokenized payment method (card) to an existing Boulevard cart", {
    cartId: z.string().describe("existing cart id"),
    token: z.string().describe("Card token returned from tokenizeCard tool"),
    select: z.boolean().default(true).describe("Whether to set this card as selected payment method"),
}, async ({ cartId, token, select }) => {
    try {
        const variables = {
            input: {
                id: cartId,
                token: token,
                select: select,
            },
        };
        const data = await gql(ADD_CART_CARD_PAYMENT_METHOD, "CLIENT", variables);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(data, null, 2),
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
const CHECKOUT_CART = `
mutation checkoutCart($id: ID!) {
  checkoutCart(input: { id: $id }) {
    appointments {
      appointmentId
      clientId
      forCartOwner
      __typename
    }
    cart {
      id
      expiresAt
      clientMessage
      startTime
      startTimeId
      guests {
        id
        firstName
        lastName
        email
        label
        number
        phoneNumber
        __typename
      }
      selectedItems {
        id
        lineTotal
        price
        selectedPaymentMethod {
          id
          name
          ... on CartItemCardPaymentMethod {
            cardBrand
            cardExpMonth
            cardExpYear
            cardHolder
            cardIsDefault
            cardLast4
            __typename
          }
          __typename
        }
        ... on CartBookableItem {
          item {
            id
            name
            optionGroups {
              id
              name
              __typename
            }
            __typename
          }
          selectedStaffVariant {
            duration
            id
            price
            staff {
              id
              displayName
              firstName
              lastName
              __typename
            }
            __typename
          }
          guest {
            id
            firstName
            lastName
            email
            label
            number
            phoneNumber
            __typename
          }
          guestId
          selectedOptions {
            id
            name
            priceDelta
            groupId
            durationDelta
            description
            __typename
          }
          __typename
        }
        __typename
      }
      availablePaymentMethods {
        id
        name
        ... on CartItemCardPaymentMethod {
          cardBrand
          cardExpMonth
          cardExpYear
          cardHolder
          cardIsDefault
          cardLast4
          __typename
        }
        ... on CartItemVoucherPaymentMethod {
          availableCount
          expiresOn
          __typename
        }
        __typename
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
        __typename
      }
      clientInformation {
        email
        firstName
        lastName
        phoneNumber
        externalId
        __typename
      }
      location {
        id
        name
        businessName
        contactEmail
        tz
        address {
          city
          state
          country
          line1
          line2
          province
          zip
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}
`;
server.tool("checkoutCart", "Perform final checkout for a Boulevard cart", {
    cartId: z.string().describe("existing cart id (e.g., urn:blvd:Cart:23f5903a-3476-478a-8096-da405bf11d53)"),
}, async ({ cartId }) => {
    try {
        const data = await gql(CHECKOUT_CART, "CLIENT", { id: cartId });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(data, null, 2),
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
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("BLVD ENTERPRISE Appointment Booking MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
