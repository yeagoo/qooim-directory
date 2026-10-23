// Qoo.IM-specific strings (namespace "qooim.catalog"): catalog, category, detail and 404 pages.
export default {
  en: {
    github: {
      title: "GitHub repository",
      stars: "Stars",
      forks: "Forks",
      openIssues: "Open issues",
      language: "Language",
      license: "License",
      pushedAt: "Last push",
      archived: "Archived",
      viewRepo: "View on GitHub",
    },
    // M13a rich listing fields.
    detail: {
      overview: "Overview",
      keyFeatures: "Key features",
      useCases: "Use cases",
      prosCons: "Pros & cons",
      pros: "Pros",
      cons: "Cons",
      updated: "Updated",
      tags: "Tags",
    },
    pricing: { openSource: "Open source" },
    tag: {
      browseTag: "Tools tagged {tag}",
      browseOther: "Browse other tags",
      noToolsWithTag: "No tools with this tag yet",
    },
    submitSimilarHint: "Recommend it to us so more people can discover it.",
    otherLanguages: "This page is available in:",
    localeNames: { zh: "中文", en: "English" },
  } as Record<string, unknown>,
  zh: {
    github: {
      title: "GitHub 仓库",
      stars: "星标",
      forks: "Fork",
      openIssues: "未关闭 Issue",
      language: "语言",
      license: "许可证",
      pushedAt: "最近提交",
      archived: "已归档",
      viewRepo: "在 GitHub 查看",
    },
    // M13a rich listing fields.
    detail: {
      overview: "概览",
      keyFeatures: "主要功能",
      useCases: "使用场景",
      prosCons: "优点与不足",
      pros: "优点",
      cons: "不足",
      updated: "更新于",
      tags: "标签",
    },
    pricing: { openSource: "开源" },
    tag: {
      browseTag: "标签为 {tag} 的工具",
      browseOther: "浏览其他标签",
      noToolsWithTag: "这个标签下还没有工具",
    },
    submitSimilarHint: "推荐给我们，让更多人发现它。",
    otherLanguages: "该页面有以下语言版本：",
    localeNames: { zh: "中文", en: "English" },
  } as Record<string, unknown>,
};
