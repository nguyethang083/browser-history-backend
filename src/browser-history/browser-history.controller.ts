import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { BrowserHistoryService, DailyReport } from './browser-history.service';

@Controller('browser-history')
export class BrowserHistoryController {
  constructor(private readonly browserHistoryService: BrowserHistoryService) {}

  @Post('store')
  async storeHistory(
    @Body('date') date: string,
    @Body('account') account: { email: string; name: string },
    @Body('data') data: any[],
  ): Promise<{ message: string }> {
    await this.browserHistoryService.storeHistoryWithAccount(
      date,
      account,
      data,
    );
    return { message: 'History and account stored successfully' };
  }

  @Get()
  async getHistory(
    @Query('date') date: string,
    @Query('email') email: string,
  ): Promise<{ account: { email: string; name: string }; history: any[] }> {
    return await this.browserHistoryService.getHistory(date, email);
  }

  @Post('process-chunk/:date/:email')
  async processChunk(
    @Param('date') date: string,
    @Param('email') email: string,
    @Body('chunkSize') chunkSize: number,
  ): Promise<{ message: string; completed: boolean }> {
    const { completed } = await this.browserHistoryService.processNextChunk(
      date,
      email,
      chunkSize,
    );
    return {
      message: completed
        ? 'All chunks processed'
        : 'Chunk processed successfully',
      completed,
    };
  }

  @Post('finalize-report/:date/:email')
  async finalizeReport(
    @Param('date') date: string,
    @Param('email') email: string,
  ): Promise<DailyReport> {
    return await this.browserHistoryService.finalizeDailyReport(date, email);
  }

  @Get('daily-report/:date/:email')
  async getDailyReport(
    @Param('date') date: string,
    @Param('email') email: string,
  ): Promise<DailyReport> {
    return await this.browserHistoryService.getDailyReport(date, email);
  }
}
