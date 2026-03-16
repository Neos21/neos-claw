import { BaseResearcher } from './base-researcher.js';

import type { SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

export class ZennResearcher extends BaseResearcher {
  protected readonly platform = 'zenn' as const;
  
  // Zenn の検索ページ (記事のみ・関連度順)
  protected readonly searchUrl = 'https://zenn.dev/search?q={query}&topicname=&order=daily';
  
  constructor(fetchTool: AgentTool | null, debug = false) {
    super(fetchTool, debug);
  }
  
  protected extractUrls(html: string): Array<string> {
    // Zenn の記事 URL パターン : `/username/articles/slug`
    const pattern = /https:\/\/zenn\.dev\/[a-zA-Z0-9_]+\/articles\/[a-zA-Z0-9_-]+/g;
    const matches = html.match(pattern) ?? [];
    return [...new Set(matches)];
  }
  
  protected parseArticle(url: string, html: string): SimilarArticle | null {
    // タイトル (「| Zenn」を除去)
    const titleMatch =
      html.match(/<meta property="og:title" content="([^"]+)"/) ??
      html.match(/<title>([^<]+)<\/title>/);
    const rawTitle = titleMatch?.[1]?.trim() ?? url;
    const title = rawTitle.replace(/\s*[|｜]\s*Zenn\s*$/, '').trim();
    
    // いいね数
    const likesMatch =
      html.match(/["']liked_count["']\s*:\s*(\d+)/) ??
      html.match(/(\d+)\s*(?:いいね|Likes?)/);
    const likes = likesMatch != null ? parseInt(likesMatch[1] ?? '0', 10) : undefined;
    
    // 有料記事の判定
    const isPaid =
      html.includes('"is_pro":true') ||
      (html.includes('"price":') && !html.includes('"price":0'));
    
    // 概要
    const summaryMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
    const summary = summaryMatch?.[1]?.trim();
    
    return { title, url, likes, isPaid, summary };
  }
}
