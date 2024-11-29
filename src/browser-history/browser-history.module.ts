import { Module } from '@nestjs/common';
import { BrowserHistoryService } from './browser-history.service';
import { BrowserHistoryController } from './browser-history.controller';
import { RedisService } from 'src/redis/redis.service';

@Module({
  controllers: [BrowserHistoryController],
  providers: [BrowserHistoryService, RedisService],
})
export class BrowserHistoryModule {}
