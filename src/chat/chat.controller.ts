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
}
