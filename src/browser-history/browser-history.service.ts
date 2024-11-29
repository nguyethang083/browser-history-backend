import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { Groq } from 'groq-sdk';
import { ConfigService } from '@nestjs/config';
import { URL } from 'url';

export interface DailyReport {
  totalVisits: number;
  categories: {
    [key: string]: number;
  };
  mostVisitedSites: {
    url: string;
    category: string;
    visits: number;
  }[];
  mostFrequentCategory: {
    category: string;
    frequency: number;
  };
  mostFrequentSite: {
    url: string;
    category: string;
    visits: number;
  };
}

@Injectable()
export class BrowserHistoryService {
  private readonly groq: Groq;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not defined in environment variables');
    }
    this.groq = new Groq({ apiKey });
  }

  private async analyzeChunk(chunk: any[]): Promise<DailyReport> {
    const historyText = chunk
      .map((item) => `${item.url} - ${item.title || ''}`)
      .join('\n');

    const prompt = `
      Analyze this browser history chunk by categorizing each site based on its content into one of the following categories:
      ["News", "Social Media", "Shopping", "Entertainment", "Education", "Technology", "Health", "Finance", "Travel", "Sports", "General"]
  
      Access the content of each URL to determine its appropriate category. Provide the total number of visits, a breakdown of visits by category, and the most visited sites. 
      If the content of a URL does not fit any specific category, classify it as "Others."
  
      Return only a JSON object in the following format:
      {
        "totalVisits": number,
        "categories": {"category1": number, "category2": number, ...},
        "mostVisitedSites": [{"url": "string", "category": "string", "visits": number}, ...],
        "mostFrequentCategory": {"category": "string", "frequency": number},
        "mostFrequentSite": {"url": "string", "category": "string", "visits": number}
      }
  
      Do not include any additional text, preface, or description beyond the requested JSON object. Analyze the following URLs and their content:
      ${historyText}
    `;

    try {
      const completion = await this.groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama3-8b-8192',
        temperature: 1,
        max_tokens: 1024,
        top_p: 1,
      });

      let responseContent = completion.choices[0]?.message?.content || '';
      console.log('Raw Response:', responseContent);

      const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        responseContent = jsonMatch[0];
        console.log('Extracted JSON:', responseContent);
      } else {
        console.warn('No valid JSON found in response.');
        throw new Error('Invalid JSON format in AI response.');
      }
      return JSON.parse(responseContent);
    } catch (error) {
      console.error('Error analyzing chunk or invalid JSON response:', error);
      return {
        totalVisits: 0,
        categories: {},
        mostVisitedSites: [],
        mostFrequentCategory: { category: 'General', frequency: 0 },
        mostFrequentSite: { url: '', category: 'General', visits: 0 },
      };
    }
  }

  async processNextChunk(
    date: string,
    email: string,
    chunkSize: number,
  ): Promise<{ completed: boolean }> {
    const history = await this.getHistory(date, email);
    const totalChunks = Math.ceil(history.history.length / chunkSize);
    const currentChunkIndex = await this.getChunkProgress(date, email);

    if (currentChunkIndex >= totalChunks) {
      return { completed: true }; // All chunks processed
    }

    // Get the current chunk
    const start = currentChunkIndex * chunkSize;
    const end = start + chunkSize;
    const chunk = history.history.slice(start, end);

    // Analyze the chunk
    const chunkReport = await this.analyzeChunk(chunk);

    // Store the chunk report in Redis
    const chunkKey = `chunk-report:${date}:${email}:${currentChunkIndex}`;
    await this.redisService.set(chunkKey, chunkReport);

    // Update progress
    await this.setChunkProgress(date, email, currentChunkIndex + 1);

    return { completed: false };
  }

  async getHistory(
    date: string,
    email: string,
  ): Promise<{ account: { email: string; name: string }; history: any[] }> {
    const redisKey = `browser-history:${date}:${email}`;
    const result = await this.redisService.get(redisKey);

    if (!result || !result.history || !result.account) {
      throw new Error(
        `No history found for the date: ${date} and email: ${email}`,
      );
    }

    return result;
  }

  private async getChunkProgress(date: string, email: string): Promise<number> {
    const progressKey = `chunk-progress:${date}:${email}`;
    const progress = await this.redisService.get(progressKey);
    return progress ? parseInt(progress, 10) : 0;
  }

  private async setChunkProgress(
    date: string,
    email: string,
    progress: number,
  ): Promise<void> {
    const progressKey = `chunk-progress:${date}:${email}`;
    await this.redisService.set(progressKey, progress.toString());
  }

  async storeHistoryWithAccount(
    date: string,
    account: { email: string; name: string },
    data: any[],
  ): Promise<void> {
    const redisKey = `browser-history:${date}:${account.email}`;
    const payload = { account, history: data };
    await this.redisService.set(redisKey, payload);
  }

  async finalizeDailyReport(date: string, email: string): Promise<DailyReport> {
    const reports: DailyReport[] = [];
    let chunkIndex = 0;

    // Dynamically retrieve all chunk reports from Redis
    while (true) {
      const chunkKey = `chunk-report:${date}:${email}:${chunkIndex}`;
      const report = await this.redisService.get(chunkKey);
      if (!report) {
        break; // Exit loop if no more chunks are found
      }
      reports.push(report);
      chunkIndex++;
    }

    if (reports.length === 0) {
      console.warn(`No chunk reports found for date: ${date}, email: ${email}`);
      return {
        totalVisits: 0,
        categories: {},
        mostVisitedSites: [],
        mostFrequentCategory: { category: 'General', frequency: 0 },
        mostFrequentSite: { url: '', category: 'General', visits: 0 },
      };
    }

    // Aggregate all chunk reports
    const finalReport = this.aggregateReports(reports);

    // Store the aggregated report in Redis
    const reportKey = `daily-report:${date}:${email}`;
    await this.redisService.set(reportKey, finalReport);

    return finalReport;
  }

  async getDailyReport(date: string, email: string): Promise<DailyReport> {
    const reportKey = `daily-report:${date}:${email}`;
    const result = await this.redisService.get(reportKey);

    if (!result) {
      throw new Error(
        `No daily report found for date: ${date} and email: ${email}`,
      );
    }

    return result;
  }
  private aggregateReports(reports: DailyReport[]): DailyReport {
    const aggregatedReport: DailyReport = {
      totalVisits: 0,
      categories: {},
      mostVisitedSites: [],
      mostFrequentCategory: { category: 'General', frequency: 0 },
      mostFrequentSite: { url: '', category: 'General', visits: 0 },
    };

    const siteVisitMap = new Map<
      string,
      { visits: number; category: string }
    >();

    for (const report of reports) {
      aggregatedReport.totalVisits += report.totalVisits;

      // Aggregate categories
      for (const [category, count] of Object.entries(report.categories)) {
        aggregatedReport.categories[category] =
          (aggregatedReport.categories[category] || 0) + count;
      }

      // Aggregate most visited sites by main URL prefix
      for (const site of report.mostVisitedSites) {
        const mainUrl = this.extractMainUrl(site.url);
        if (siteVisitMap.has(mainUrl)) {
          const existing = siteVisitMap.get(mainUrl)!;
          siteVisitMap.set(mainUrl, {
            visits: existing.visits + site.visits,
            category: site.category, // Use the most frequent category if needed
          });
        } else {
          siteVisitMap.set(mainUrl, {
            visits: site.visits,
            category: site.category,
          });
        }
      }
    }

    // Sort and get top 5 most visited sites
    aggregatedReport.mostVisitedSites = Array.from(siteVisitMap.entries())
      .map(([url, { visits, category }]) => ({ url, visits, category }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 5);

    // Determine most frequent category
    const mostFrequentCategory = Object.entries(
      aggregatedReport.categories,
    ).sort((a, b) => b[1] - a[1])[0];
    if (mostFrequentCategory) {
      aggregatedReport.mostFrequentCategory = {
        category: mostFrequentCategory[0],
        frequency: mostFrequentCategory[1],
      };
    }

    // Determine most frequent site
    if (aggregatedReport.mostVisitedSites.length > 0) {
      const mostFrequentSite = aggregatedReport.mostVisitedSites[0];
      aggregatedReport.mostFrequentSite = {
        url: mostFrequentSite.url,
        category: mostFrequentSite.category,
        visits: mostFrequentSite.visits,
      };
    }

    return aggregatedReport;
  }

  private extractMainUrl(fullUrl: string): string {
    try {
      const url = new URL(fullUrl);

      // If the path is trivial (e.g., '/' or empty), return the origin with '/'
      if (
        !url.pathname ||
        url.pathname === '/' ||
        url.pathname.split('/').length <= 2
      ) {
        return `${url.origin}/`;
      }

      // Otherwise, return only the origin to ensure grouping by root domain
      return `${url.origin}/`;
    } catch {
      console.error('Invalid URL:', fullUrl);
      return fullUrl; // Return original URL if parsing fails
    }
  }
}
