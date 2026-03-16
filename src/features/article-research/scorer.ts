export type Platform = 'note' | 'zenn';

/** 類似記事1件分のデータ */
export interface SimilarArticle {
  title: string;
  url: string;
  /** いいね・スキ数 (取得できた場合) */
  likes?: number;
  /** 有料記事またはお布施設定があるか否か */
  isPaid: boolean;
  /** 記事の概要 */
  summary?: string;
}

/** 1プラットフォームの調査結果 */
export interface PlatformResearch {
  platform: Platform;
  topic: string;
  /** 見つかった類似記事一覧 */
  articles: Array<SimilarArticle>;
  /** 調査時のエラーメッセージ (失敗時) */
  error?: string;
}

/** スコアリング結果 */
export interface PlatformScore {
  platform: Platform;
  /** 総合スコア 1〜5 */
  score: number;
  /** ニッチ度 1〜5 (競合が少ないほど高い) */
  nicheScore: number;
  /** 有料化ポテンシャル 1〜5 */
  paidPotential: number;
  /** 差別化ポイントの提案 */
  differentiationTips: Array<string>;
  /** スコアの根拠説明 */
  rationale: string;
}

/** 最終レポート */
export interface ArticleReport {
  topic: string;
  generatedAt: Date;
  note: {
    research: PlatformResearch;
    score: PlatformScore;
  };
  zenn: {
    research: PlatformResearch;
    score: PlatformScore;
  };
}

/** 調査結果からスコアを算出する・LLM を使わず決定的なルールで計算するため、再現性がある */
export function score(research: PlatformResearch): PlatformScore {
  const { platform, articles } = research;
  
  // ニッチ度 (競合の少なさ) : 類似記事が少ないほど高スコア
  const count = articles.length;
  const nicheScore =
    count === 0 ? 5 :
    count <= 2  ? 4 :
    count <= 5  ? 3 :
    count <= 10 ? 2 : 1;
  
  // 有料化ポテンシャル : 類似記事の中に有料記事がある → 有料化が成立している市場
  const paidCount = articles.filter(article => article.isPaid).length;
  const paidRatio = count > 0 ? paidCount / count : 0;
  const paidPotential =
    paidRatio >= 0.5 ? 5 :
    paidRatio >= 0.3 ? 4 :
    paidRatio >= 0.1 ? 3 :
    paidCount > 0    ? 2 : 1;
  
  // 総合スコア
  const score = Math.round((nicheScore * 0.5 + paidPotential * 0.5));
  
  // 差別化ポイントの提案
  const tips: Array<string> = [];
  
  if(nicheScore >= 4) {
    tips.push('競合が少ないので先行者優位が取れます');
  }
  else {
    tips.push('競合が多いため、独自の視点や深掘りが必要です');
  }
  
  if(paidPotential >= 4) {
    tips.push('有料記事が成立している市場なので、有料化を積極的に検討してください');
  }
  else if(paidPotential >= 2) {
    tips.push('一部有料化の実績あり。内容次第でお布施設定も狙えます');
  }
  else {
    tips.push('無料記事が多い領域です。差別化できれば有料化の余地があります');
  }
  
  if(platform === 'zenn') {
    tips.push('Zenn は技術系読者が多いので、コード例や実装の詳細を充実させると刺さります');
  }
  else {
    tips.push('note は文章・体験談が好まれます。個人の経験や失敗談を交えると読まれやすいです');
  }
  
  // 根拠
  const rationale =
    `類似記事 ${count} 件 (うち有料 ${paidCount} 件)。` +
    `ニッチ度 ${nicheScore}/5、有料化ポテンシャル ${paidPotential}/5。`;
  
  return { platform, score, nicheScore, paidPotential, differentiationTips: tips, rationale };
}

/** ArticleReport をテキストに整形する (Slack・Discord・Web UI 共通) */
export function formatReport(report: ArticleReport): string {
  const stars = (number: number): string => '★'.repeat(number) + '☆'.repeat(5 - number);
  const platform = (label: string, research: PlatformResearch, score: PlatformScore): string => {
    const lines: Array<string> = [];
    lines.push(`## ${label} ・ ${stars(score.score)}`);
    lines.push(`ニッチ度 : ${stars(score.nicheScore)} ・ 有料化ポテンシャル : ${stars(score.paidPotential)}`);
    lines.push(score.rationale);
    lines.push('');
    
    if(research.error != null) {
      lines.push(`⚠️ 調査エラー : ${research.error}`);
    }
    else if(research.articles.length === 0) {
      lines.push('類似記事は見つかりませんでした (ニッチ!)');
    }
    else {
      lines.push('**類似記事 :**');
      for(const article of research.articles.slice(0, 5)) {
        const paid = article.isPaid ? '💰' : '';
        const likes = article.likes != null ? ` 👍${article.likes}` : '';
        lines.push(`- ${paid}[${article.title}](${article.url})${likes}`);
      }
    }
    
    lines.push('');
    lines.push('**差別化ポイント :**');
    for(const tip of score.differentiationTips) lines.push(`- ${tip}`);
    
    return lines.join('\n');
  };
  
  const sections: Array<string> = [];
  sections.push(`# 記事ネタ判定 : 「${report.topic}」`);
  sections.push(`調査日時 : ${report.generatedAt.toLocaleString('ja-JP')}`);
  sections.push('');
  sections.push(platform('note', report.note.research, report.note.score));
  sections.push('---');
  sections.push(platform('Zenn', report.zenn.research, report.zenn.score));
  
  // 総合推奨
  const noteTotal = report.note.score;
  const zennTotal = report.zenn.score;
  sections.push('---');
  if(noteTotal > zennTotal) {
    sections.push(`✅ **総合推奨 : note** (${noteTotal} > ${zennTotal})`);
  }
  else if(zennTotal > noteTotal) {
    sections.push(`✅ **総合推奨 : Zenn** (${zennTotal} > ${noteTotal})`);
  }
  else {
    sections.push(`✅ **総合推奨 : どちらも同スコア (${noteTotal})** … 両方投稿もアリ`);
  }
  
  return sections.join('\n');
}
