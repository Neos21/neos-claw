import { BaseResearcher, type SearchResult } from './base-researcher.js';

import type { SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

interface NoteSearchResponse {
  data: {
    notes: Array<{
      key: string;
      name: string;
      like_count: number;
      price: number;
      user: { urlname: string };
    }>;
  };
}

export class NoteResearcher extends BaseResearcher {
  protected readonly platform = 'note' as const;
  protected readonly siteDomain = 'note.com';
  
  constructor(fetchJsonTool: AgentTool | null, fetchTool: AgentTool | null, debug = false) {
    super(fetchJsonTool, fetchTool, debug);
  }
  
  protected async searchArticles(topic: string): Promise<SearchResult> {
    const apiUrl = `https://note.com/api/v3/searches?context=note&q=${encodeURIComponent(topic)}&size=10&start=0`;
    let apiUrls: Array<string> = [];
    const apiSearchUrl = apiUrl;
    
    // Step 1 : note 非公式 API
    if(this.fetchJsonTool != null) {
      this.log(`Calling note API : ${apiUrl}`);
      try {
        const raw = await this.fetchJsonTool.execute({ url: apiUrl, max_length: 100000 });
        const data = JSON.parse(raw) as NoteSearchResponse;
        const notesObj = data?.data?.notes;
        const notes: Array<any> = ((notesObj != null && 'contents' in notesObj) ? notesObj.contents : []) as Array<any>;
        this.log(`note API Returned ${notes.length} Notes`);
        apiUrls = notes.map(note => `https://note.com/${note.user.urlname}/n/${note.key}`);
      }
      catch(error) {
        this.log('note API Failed :', error);
      }
    }
    
    // Step 2 : Web 検索フォールバック
    const { urls: webUrls, usedUrl: webSearchUrl } = await this.webSearchFallback(topic);
    
    // API と Web 検索の結果をマージ (重複除去)
    const merged = [...new Set([...apiUrls, ...webUrls])];
    this.log(`Merged ${merged.length} note URLs (API : ${apiUrls.length} ・ Web : ${webUrls.length})`);
    
    return {
      urls: merged,
      apiSearchUrl,
      webSearchUrl,
      searchResultCount: merged.length
    };
  }
  
  protected extractUrlsFromText(text: string): Array<string> {
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
      html.includes('"is_paid":true') ||  // eslint-disable-line neos-eslint-plugin/comment-colon-spacing
      html.includes('有料記事') ||
      html.includes('購入する');
    
    const summaryMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const summary = summaryMatch?.[1]?.trim();
    
    return { title, url, likes, isPaid, summary };
  }
}
