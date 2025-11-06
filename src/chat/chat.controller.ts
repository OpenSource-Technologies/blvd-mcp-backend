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

    this.chatService.setPaymentToken(token);

    if (!token) {
      console.log('No token from frontend:', token);

      return { success: false, message: 'No token received.' };
    }

    console.log('💳 Received token from frontend:', token);

    return { success: true, message: 'Token received successfully.' };
  }

  
}
