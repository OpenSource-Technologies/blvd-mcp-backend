import { Controller, Post, Body } from '@nestjs/common';
import { ChatService } from './chat.service.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async chat(@Body('chatInput') message: string, @Body('sessionId') sessionId: string, @Body('uuid') uuid: string) {
    const response = await this.chatService.sendMessage(message, sessionId, uuid);
    return response; // ✅ don’t wrap it again
  }

  @Post('receive-token')
  async receiveToken(@Body('token') token: string, @Body('sessionId') sessionId: string,  @Body('uuid') uuid: string) {
    if (!token) {
      return {
        reply: {
          role: 'assistant',
          content: 'No token received.'
        }
      };
    }
  
    const checkoutResult = await this.chatService.setPaymentToken(token, sessionId, uuid);
  
    if (!checkoutResult) {
      return {
        reply: {
          role: 'assistant',
          content: 'Checkout failed. See backend logs.'
        }
      };
    }
  // 1. Extract the raw text
const raw = checkoutResult?.content?.[0]?.text;

// 2. Parse JSON
const data = JSON.parse(raw);

// 3. Extract summary
const summary = data.checkoutCart.cart.summary;

// 4. Convert cents → dollars
const subtotal = (summary.subtotal / 100).toFixed(2);
const discount = (summary.discountAmount / 100).toFixed(2);
const tax = (summary.taxAmount / 100).toFixed(2);
const total = (summary.total / 100).toFixed(2);

// 5. Build final content string
// const content =
//   `🧾 **Checkout Summary**\n\n\n` +
//   `Subtotal: $${subtotal}\n\n` +
//   `Discount: $${discount}\n\n` +
//   `Tax: $${tax}\n\n` +
//   `Total: $${total}\n\n` +
//   `🙏 Thank you for your purchase!`;

const lines = [
  subtotal !== "0.00" ? `Subtotal: $${subtotal}` : "",
  discount !== "0.00" ? `Discount: $${discount}` : "",
  tax !== "0.00" ? `Tax: $${tax}` : "",
  total !== "0.00" ? `Total: $${total}` : "",
];

const content = `🧾 **Checkout Summary**\n\n` + lines.filter(line => line !== "").join("\n\n") + `\n\n🙏 Thank you for your purchase!`;

  this.chatService.cleanupAfterCheckout(sessionId);

// 6. Wrap in reply object
return {
  reply: {
    role: "assistant",
    content
  }
}}

  @Post('prompt-suggestions')
  async promptSuggestions(@Body('userContent') userContent: string) {
    const suggestions = await this.chatService.promptSuggestions(userContent);
    return suggestions;
  }
}
