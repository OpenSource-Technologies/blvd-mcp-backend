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
  console.error("requestType  >> ",requestType)
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

        console.error("authenticationHeader == ",authenticationHeader);
        console.error("API  >> ",API)
        
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

const GQL_LIST_MEMBERSHIP_PLANS = /* GraphQL */ `query membershipPlans {
        membershipPlans(first: 1000) {
          edges {
              node {
                  id 
                  name
                  active 
                  unitPrice
                  description
                  category {
                    id
                    name
                  }
              }
            } 
          }
        }`;

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

const ADD_MEMBERSHIP_TO_CART = `mutation addCartSelectedPurchasableItem($input:AddCartSelectedPurchasableItemInput!){
      addCartSelectedPurchasableItem(input:$input){
       cart {
  id
  selectedItems {
        id
  }
}

      }
    }`;

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
          item {
            id
            name
          }
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


server.tool(
  "getLocations",
  "Get available locations for the business",
  async () =>{
    const data = await gql(GQL_LOCATIONS, 'CLIENT', { businessId: BLVD_BUSINESS_ID });
    // const locations = data?.locations?.edges ?? [];

    const locations = {
      locations: data?.locations?.edges?.map(e => ({
        id: e?.node?.id,
        name: e?.node?.name || e?.node?.businessName,
        city: e?.node?.address?.city,
      })) ?? []
  };
    return { content: [{ type: "text", text: JSON.stringify(locations) }] };
  }
);

server.tool(
  "getMembershipPlans",
  "Get available membership plans",
  async () =>{
    const data = await gql(GQL_LIST_MEMBERSHIP_PLANS, 'ADMIN', { businessId: BLVD_BUSINESS_ID });
    return { content: [{ type: "text", text: JSON.stringify(data.membershipPlans.edges) }] };
  }
);



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


server.tool(
  "createMembershipCart",
  "Create a cart scoped to a business/location for membership purchase",
  {
    locationId: z.string().describe("location id"),
  },
  async ({locationId}) =>{
    const data = await gql(CREATE_CART, 'CLIENT', { input: {locationId: locationId} });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

server.tool(
  "addMembershipToCart",
  "Add a membership plan to an existing cart",
  {
    id: z.string().describe("existing cartId"),
    itemId: z.string().describe("membership product id")
  },
  async ({id, itemId}) =>{
    console.error("cartId >> ",id);

    console.error("itemId >> ",itemId);
    const data = await gql(ADD_MEMBERSHIP_TO_CART, 'CLIENT', { input: {
        "id":id,
        "itemId":itemId
      } });

      console.error("addMembershipToCart >> ",data);

    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

server.tool(
  "setClientOnCart",
  "Attach client info to the cart before checkout",
  {
    cartId: z.string().describe("existing cart id"),
    firstName: z.string().describe("User first name"),
    lastName: z.string().describe("User last name"),
    email: z.string().describe("User email in format: name@domain.com"),
    phoneNumber: z.string().describe("user phone number")
  },
  async ({cartId, firstName, lastName, email, phoneNumber}) =>{
    const data = await gql(SET_CLIENT_ON_CART, 'CLIENT', { input: {
        "id":cartId,
        "clientInformation":{firstName, lastName, email, phoneNumber}
      } });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

server.tool(
  "applyPromotionCode",
  "Apply a promo/discount code to the cart (optional)",
  {
    cartId: z.string().describe("existing cart id"),
    offerCode: z.string().describe("promotion code")
  },
  async ({cartId, offerCode}) =>{
    const data = await gql(APPLY_PROMOTION_CODE, 'CLIENT', { input: {
        "id":cartId,
        "offerCode":offerCode
      } });
    // const locations = data?.locations?.edges ?? [];
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

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
  console.error("BLVD ENTERPRISE MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});