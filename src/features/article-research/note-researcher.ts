import { BaseResearcher } from './base-researcher.js';

import type { SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

export class NoteResearcher extends BaseResearcher {
  protected readonly platform = 'note' as const;
  
  /** note の検索ページ (カテゴリ : テキスト、並び順 : 人気) */
  protected readonly searchUrl = 'https://note.com/search?q={query}&context=note&mode=recommend';
  
  constructor(fetchTool: AgentTool | null, debug = false) {
    super(fetchTool, debug);
  }
  
  protected extractUrls(html: string): Array<string> {
    // note の記事 URL パターン : `/username/n/xxxxxxxx`
    const pattern = /https:\/\/note\.com\/[a-zA-Z0-9_]+\/n\/[a-zA-Z0-9]+/g;
    const matches = html.match(pattern) ?? [];
    return [...new Set(matches)];
  }
  
  protected parseArticle(url: string, html: string): SimilarArticle | null {
    // タイトル
    const titleMatch =
      html.match(/<meta property="og:title" content="([^"]+)"/) ??
      html.match(/<title>([^<]+)<\/title>/);
    const title = titleMatch?.[1]?.trim() ?? url;
    
    // スキ数
    const likesMatch =
      html.match(/["']like_count["']\s*:\s*(\d+)/) ??
      html.match(/(\d+)\s*(?:スキ)/);
    const likes = likesMatch != null ? parseInt(likesMatch[1] ?? '0', 10) : undefined;
    
    // 有料記事の判定
    const isPaid =
      html.includes('"is_paid":true') ||
      html.includes('有料記事') ||
      html.includes('購入する');
    
    // 概要
    const summaryMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const summary = summaryMatch?.[1]?.trim();
    
    return { title, url, likes, isPaid, summary };
  }
}
