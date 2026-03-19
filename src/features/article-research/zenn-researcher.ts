import { BaseResearcher, type SearchResult } from './base-researcher.js';

import type { SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

interface ZennArticle {
  path: string;
  title: string;
  liked_count: number;
  is_pro: boolean;
  price: number;
}

interface ZennSearchResponse {
  articles: Array<ZennArticle>;
}

export class ZennResearcher extends BaseResearcher {
  protected readonly platform = 'zenn' as const;
  protected readonly siteDomain = 'zenn.dev';
  
  constructor(fetchJsonTool: AgentTool | null, fetchTool: AgentTool | null, debug = false) {
    super(fetchJsonTool, fetchTool, debug);
  }
  
  protected async searchArticles(topic: string): Promise<SearchResult> {
    const apiUrl = `https://zenn.dev/api/search?q=${encodeURIComponent(topic)}&order=daily&source=articles`;
    let apiUrls: Array<string> = [];
    const apiSearchUrl = apiUrl;
    
    // Step 1 : Zenn 公式 API
    if(this.fetchJsonTool != null) {
      this.log(`Calling Zenn API : ${apiUrl}`);
      try {
        const raw = await this.fetchJsonTool.execute({ url: apiUrl, max_length: 100000 });
        const data = JSON.parse(raw) as ZennSearchResponse;
        const articles = data?.articles ?? [];
        this.log(`Zenn API Returned ${articles.length} Articles`);
        apiUrls = articles.map(article => `https://zenn.dev${article.path}`);
      }
      catch(error) {
        this.log('Zenn API Failed :', error);
      }
    }
    
    // Step 2 : Web 検索フォールバック
    const { urls: webUrls, usedUrl: webSearchUrl } = await this.webSearchFallback(topic);
    
    const merged = [...new Set([...apiUrls, ...webUrls])];
    this.log(`Merged ${merged.length} Zenn URLs (API : ${apiUrls.length} ・ Web : ${webUrls.length})`);
    
    return {
      urls: merged,
      apiSearchUrl,
      webSearchUrl,
      searchResultCount: merged.length
    };
  }
  
  protected extractUrlsFromText(text: string): Array<string> {
    const pattern = /https?:\/\/zenn\.dev\/[a-zA-Z0-9_]+\/articles\/[a-zA-Z0-9_-]+/g;
    const matches = text.match(pattern) ?? [];
    return [...new Set(matches)];
  }
  
  protected parseArticle(url: string, html: string): SimilarArticle | null {
    const titleMatch =
      html.match(/<meta property="og:title" content="([^"]+)"/) ??
      html.match(/<title>([^<]+)<\/title>/);
    const rawTitle = titleMatch?.[1]?.trim() ?? url;
    const title = rawTitle.replace(/\s*[|｜]\s*Zenn\s*$/, '').trim();
    
    const likesMatch =
      html.match(/["']liked_count["']\s*:\s*(\d+)/) ??
      html.match(/(\d+)\s*(?:いいね|Likes?)/);
    const likes = likesMatch != null ? parseInt(likesMatch[1] ?? '0', 10) : undefined;
    
    const isPaid =
      html.includes('"is_pro":true') ||  // eslint-disable-line neos-eslint-plugin/comment-colon-spacing
      (html.includes('"price":') && !html.includes('"price":0'));  // eslint-disable-line neos-eslint-plugin/comment-colon-spacing
    
    const summaryMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const summary = summaryMatch?.[1]?.trim();
    
    return { title, url, likes, isPaid, summary };
  }
}
