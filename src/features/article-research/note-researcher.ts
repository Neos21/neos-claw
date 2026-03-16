import { BaseResearcher } from './base-researcher.js';

import type { SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

export class NoteResearcher extends BaseResearcher {
  protected readonly platform = 'note' as const;
  
  constructor(fetchTool: AgentTool | null, debug = false) {
    super(fetchTool, debug);
  }
  
  protected async searchArticles(topic: string): Promise<Array<string>> {
    if(this.fetchTool == null) {
      this.log('Fetch Tool Not Available');
      return [];
    }
    
    // Google → DuckDuckGo の順でフォールバック
    const engines = [
      {
        name: 'Google',
        url: `https://www.google.com/search?q=site%3Anote.com+${encodeURIComponent(topic)}&num=10&hl=ja`
      },
      {
        name: 'DuckDuckGo',
        url: `https://html.duckduckgo.com/html/?q=site%3Anote.com+${encodeURIComponent(topic)}`
      }
    ];
    
    for(const engine of engines) {
      this.log(`Searching Via ${engine.name} : ${engine.url}`);
      
      try {
        const text = await this.fetchTool.execute({ url: engine.url });
        const urls = this.extractNoteUrls(text);
        
        if(urls.length > 0) {
          this.log(`Extracted ${urls.length} Article URLs Via ${engine.name}`);
          return urls;
        }
        
        // URL が0件 = 弾かれた or 結果なし → 次のエンジンへ
        this.log(`${engine.name} Returned 0 URLs, Trying Next...`);
      }
      catch(error) {
        this.log(`${engine.name} Failed :`, error);
      }
    }
    
    this.log('All Search Engines Failed Or Returned 0 Results');
    return [];
  }
  
  private extractNoteUrls(text: string): Array<string> {
    const pattern = /https?:\/\/note\.com\/[a-zA-Z0-9_]+\/n\/[a-zA-Z0-9]+/g;
    const matches = text.match(pattern) ?? [];
    return [...new Set(matches)];
  }
  
  protected parseArticle(url: string, html: string): SimilarArticle | null {
    const titleMatch =
      html.match(/<meta property="og:title" content="([^"]+)"/) ??
      html.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch?.[1]?.trim() ?? url;
    
    const likesMatch =
      html.match(/["']like_count["']\s*:\s*(\d+)/) ??
      html.match(/(\d+)\s*(?:スキ)/);
    const likes = likesMatch != null ? parseInt(likesMatch[1] ?? '0', 10) : undefined;
    
    const isPaid =
      html.includes('"is_paid":true') ||
      html.includes('有料記事') ||
      html.includes('購入する');
    
    const summaryMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const summary = summaryMatch?.[1]?.trim();
    
    return { title, url, likes, isPaid, summary };
  }
}
