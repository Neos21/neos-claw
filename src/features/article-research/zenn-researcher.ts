import { BaseResearcher } from './base-researcher.js';

import type { SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

/** Zenn API のレスポンス型 (一部) */
interface ZennArticle {
  path: string;
  title: string;
  liked_count: number;
  comments_count: number;
  is_pro: boolean;
  price: number;
  emoji: string;
  user: { username: string };
}

interface ZennSearchResponse {
  articles: Array<ZennArticle>;
}

export class ZennResearcher extends BaseResearcher {
  protected readonly platform = 'zenn' as const;
  
  constructor(fetchTool: AgentTool | null, debug = false) {
    super(fetchTool, debug);
  }
  
  /**
   * Zenn の公式検索 API を使って記事一覧を取得する
   * 
   * SPA の検索ページと違い JSON が直接返るので確実に取得できる
   */
  protected async searchArticles(topic: string): Promise<Array<string>> {
    if(this.fetchTool == null) {
      this.log('Fetch Tool Not Available');
      return [];
    }
    
    const apiUrl = `https://zenn.dev/api/search?q=${encodeURIComponent(topic)}&order=daily&source=articles`;
    this.log(`Calling Zenn API : ${apiUrl}`);
    
    try {
      const raw = await this.fetchTool.execute({ url: apiUrl });
      
      // fetch_txt / fetch_readable は Markdown や本文テキストを返すので JSON 部分だけ抽出してパースする
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if(jsonMatch == null) {
        this.log('No JSON Found In Response');
        return [];
      }
      
      const data = JSON.parse(jsonMatch[0]) as ZennSearchResponse;
      const articles = data.articles ?? [];
      this.log(`API Returned ${articles.length} Articles`);
      
      return articles.map(article => `https://zenn.dev${article.path}`);
    }
    catch(error) {
      this.log('Failed To Call Zenn API :', error);
      return [];
    }
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
      html.includes('"is_pro":true') ||
      (html.includes('"price":') && !html.includes('"price":0'));
    
    const summaryMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const summary = summaryMatch?.[1]?.trim();
    
    return { title, url, likes, isPaid, summary };
  }
}
