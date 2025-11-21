import { Controller, Post, Body } from '@nestjs/common';
import { ChatService } from './chat.service.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async chat(@Body('chatInput') message: string) {
    const response = await this.chatService.sendMessage(message);
    return response; // ✅ don’t wrap it again
  }

  @Post('receive-token')
  async receiveToken(@Body('token') token: string) {
    if (!token) {
      return {
        reply: {
          role: 'assistant',
          content: 'No token received.'
        }
      };
    }
  
    const checkoutResult = await this.chatService.setPaymentToken(token);
  
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
const tax = (summary.taxAmount / 100).toFixed(2);
const total = (summary.total / 100).toFixed(2);

// 5. Build final content string
const content =
  `🧾 **Checkout Summary**\n` +
  `Subtotal: $${subtotal}\n` +
  `Tax: $${tax}\n` +
  `Total: $${total}\n\n` +
  `🙏 Thank you for your purchase!`;

  this.chatService.cleanupAfterCheckout("default");

// 6. Wrap in reply object
return {
  reply: {
    role: "assistant",
    content
  }
}}
  
}
