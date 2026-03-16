import type { Platform, PlatformResearch, SimilarArticle } from './scorer.js';
import type { AgentTool } from '../../agent/core.js';

export interface SearchResult {
  urls: Array<string>;
  /** プラットフォーム公式・非公式 API の検索 URL */
  apiSearchUrl: string;
  /** Google か DuckDuckGo の検索 URL（使用した方・失敗時は空文字） */
  webSearchUrl: string;
  searchResultCount: number;
}

/** note・Zenn 共通のリサーチ基底クラス */
export abstract class BaseResearcher {
  protected abstract readonly platform: Platform;
  
  constructor(
    /** JSON 取得用 (fetch_json を優先) */
    protected readonly fetchJsonTool: AgentTool | null,
    /** HTML/テキスト取得用 (fetch_readable / fetch_txt) */
    protected readonly fetchTool: AgentTool | null,
    protected readonly debug: boolean = false
  ) {}
  
  public async research(topic: string): Promise<PlatformResearch> {
    this.log(`Researching "${topic}" On ${this.platform}...`);
    
    try {
      const { urls, apiSearchUrl, webSearchUrl, searchResultCount } = await this.searchArticles(topic);
      this.log(`Found ${urls.length} URLs`);
      
      const articles = await this.fetchArticles(urls);
      this.log(`Parsed ${articles.length} Articles`);
      
      return { platform: this.platform, topic, articles, apiSearchUrl, webSearchUrl, searchResultCount };
    }
    catch(error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Error : ${errorMessage}`);
      return { platform: this.platform, topic, articles: [], apiSearchUrl: '', webSearchUrl: '', searchResultCount: 0, error: errorMessage };
    }
  }
  
  protected abstract searchArticles(topic: string): Promise<SearchResult>;
  protected abstract parseArticle(url: string, html: string): SimilarArticle | null;
  
  /**
   * Google → DuckDuckGo の順で検索してURLを抽出する共通メソッド
   * 
   * note は `note.com` の URL を、Zenn は `zenn.dev` の URL を抽出する
   */
  protected async webSearchFallback(topic: string): Promise<{ urls: Array<string>; usedUrl: string }> {
    if(this.fetchTool == null) return { urls: [], usedUrl: '' };
    
    const engines = [
      {
        name: 'Google',
        url: `https://www.google.com/search?q=site%3A${this.siteDomain}+${encodeURIComponent(topic)}&num=10&hl=ja`
      },
      {
        name: 'DuckDuckGo',
        url: `https://html.duckduckgo.com/html/?q=site%3A${this.siteDomain}+${encodeURIComponent(topic)}`
      }
    ];
    
    for(const engine of engines) {
      this.log(`Web Search Fallback Via ${engine.name} : ${engine.url}`);
      try {
        const text = await this.fetchTool.execute({ url: engine.url, max_length: 100000 });
        const urls = this.extractUrlsFromText(text);
        if(urls.length > 0) {
          this.log(`Extracted ${urls.length} URLs Via ${engine.name}`);
          return { urls, usedUrl: engine.url };
        }
        this.log(`${engine.name} Returned 0 URLs, Trying Next...`);
      }
      catch(error) {
        this.log(`${engine.name} Failed :`, error);
      }
    }
    
    const lastUrl = engines[engines.length - 1]?.url ?? '';
    return { urls: [], usedUrl: lastUrl };
  }
  
  /** プラットフォームのドメイン (サブクラスで定義) */
  protected abstract readonly siteDomain: string;
  
  /** テキストからプラットフォームの記事 URL を抽出する (サブクラスで実装) */
  protected abstract extractUrlsFromText(text: string): Array<string>;
  
  protected async fetchArticles(urls: Array<string>): Promise<Array<SimilarArticle>> {
    if(this.fetchTool == null || urls.length === 0) return [];
    
    const results = await Promise.allSettled(
      urls.slice(0, 5).map(url => this.fetchAndParse(url))
    );
    
    return results
      .filter((result): result is PromiseFulfilledResult<SimilarArticle | null> => result.status === 'fulfilled')
      .map(result => result.value)
      .filter((article): article is SimilarArticle => article != null);
  }
  
  protected async fetchAndParse(url: string): Promise<SimilarArticle | null> {
    if(this.fetchTool == null) return null;
    try {
      this.log(`Fetching Article : ${url}`);
      const html = await this.fetchTool.execute({ url });
      return this.parseArticle(url, html);
    }
    catch(error) {
      this.log(`Failed To Fetch ${url} :`, error);
      return null;
    }
  }
  
  protected log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[${this.platform}Researcher] ${message}`, ...args);
  }
}
