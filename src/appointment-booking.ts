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
    } else {
        if (!URL_ADMIN) throw new Error("Missing URL_ADMIN");
        API = URL_ADMIN!;
        authenticationHeader = await generate_admin_auth_header();
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

const APPLY_PROMO = `mutation addCartOffer($input:AddCartOfferInput!){
  addCartOffer(input:$input) { offer { applied code id name } cart { id summary { subtotal total } } }
}`;

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
