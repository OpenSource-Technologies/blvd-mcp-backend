import { Controller, Post, Body } from '@nestjs/common';
import { ChatService } from './chat.service.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  async chat(@Body('chatInput') message: string) {
    const response = await this.chatService.getResponse(message);
    return response; // ✅ don’t wrap it again
  }


  @Post('receive-token')
async receiveToken(@Body('token') token: string) {
  if (!token) return { success: false, message: 'No token received.' };

  const checkoutResult = await this.chatService.setPaymentToken(token);

  if (!checkoutResult) {
    return { success: false, message: 'Checkout failed. See backend logs.' };
  }

  return { success: true, ...checkoutResult };
}

  
  
}
