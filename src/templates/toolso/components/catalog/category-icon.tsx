// Ported from toolso-ai-open src/features/tools/components/category-icon.tsx (Apache-2.0, Copyright 2025 CoolChange.AI). Changes: none (verbatim); unknown Qoo.IM category ids use the fallback icon.
import type { ComponentType, SVGProps } from "react";
import {
  AppWindow,
  BadgeDollarSign,
  BookOpen,
  Bot,
  Box,
  BoxSelect,
  Brain,
  Blocks,
  Briefcase,
  Building2,
  Captions,
  ChartBar,
  ChartLine,
  Clapperboard,
  CircleDollarSign,
  CircleEllipsis,
  CircleDot,
  Cloud,
  Code,
  Cog,
  Database,
  Drama,
  Dumbbell,
  Eye,
  FilePenLine,
  FileText,
  Film,
  FlaskConical,
  FolderOpen,
  Gamepad2,
  Gift,
  Globe,
  GraduationCap,
  Handshake,
  Headset,
  Heart,
  Home,
  Image as ImageIcon,
  ImagePlus,
  Images,
  Landmark,
  Languages,
  ListChecks,
  Mail,
  Megaphone,
  MessageCircleMore,
  MessagesSquare,
  Mic,
  MicVocal,
  Music,
  Music2,
  MonitorCog,
  Paintbrush,
  Palette,
  PencilLine,
  PenLine,
  Plane,
  Presentation,
  Rocket,
  Scale,
  ScanSearch,
  Search,
  Shirt,
  Smile,
  Share2,
  ShoppingCart,
  Sparkles,
  Sprout,
  Table2,
  TestTube,
  TextCursorInput,
  Timer,
  Ticket,
  TrendingUp,
  Type,
  UserRound,
  UserRoundCheck,
  UsersRound,
  Video,
  Volume2,
  Wrench,
  WandSparkles,
  Workflow,
  Zap,
} from "lucide-react";

type IconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { size?: string | number }
>;

/** category slug → lucide icon component */
const CATEGORY_ICONS: Record<string, IconComponent> = {
  // 3D / vision
  "3D-generator": Box,
  "3d-generation": Box,
  "3d-tools": Box,
  "ai-3d": BoxSelect,
  "computer-vision": Eye,

  // AI 基础 / 平台
  ai: Bot,
  "ai-tool": Wrench,
  "general-artificial-intelligence": Brain,
  "generative-ai-platform": Sparkles,
  "intelligent-platform": Brain,
  "model-hub": FolderOpen,
  "model-library": BookOpen,
  "open-source-ai": Globe,
  "ai-training-platform": Dumbbell,
  "ai-detection": ScanSearch,

  // agents / 自动化
  "ai-agent": Handshake,
  "ai-agents": Handshake,
  "ai-assistant": Briefcase,
  "action-engine": Zap,
  "automation-tools": Cog,
  automations: Workflow,
  workflows: Workflow,

  // chat
  "ai-chat": MessageCircleMore,
  chatbots: MessagesSquare,
  "ai-character-chat": Drama,
  "role-play": Drama,

  // 写作 / 翻译
  "ai-writing": PencilLine,
  writing: PencilLine,
  "writing-generators": PenLine,
  "copywriting-assistant": PenLine,
  "text-generators": Type,
  "prompt-generators": TextCursorInput,
  paraphrasing: PenLine,
  summarizer: FileText,
  "ai-subtitles": FilePenLine,
  "subtitle-generation": FilePenLine,
  "translation-tool": Languages,
  translators: Languages,

  // 开发 / 网站
  code: Code,
  "code-assistant": Code,
  "ai-development": Code,
  "code-development": Code,
  "developer-tools": Wrench,
  "application-building": Building2,
  "website-generator": Globe,
  "website-builders": AppWindow,
  "no-code": Blocks,
  "sql-assistant": Database,
  "ai-browser": AppWindow,
  "proxy-services": Cloud,

  // 设计 / 图像
  art: Palette,
  "art-generators": Paintbrush,
  "ai-creativity": Palette,
  "design-tool": Palette,
  "design-generators": Palette,
  image: ImageIcon,
  "image-generation": Images,
  "image-generators": Images,
  "image-editing": ImageIcon,
  "ai-photo-editing-design": ImageIcon,
  "ai-photo-editing--design": ImageIcon,
  "text-to-image": ImagePlus,
  "avatar-generator": UserRound,
  "portrait-generators": UserRound,
  "cartoon-generators": Smile,
  "logo-generator": WandSparkles,

  // 营销 / 商业
  "ai-marketing": Megaphone,
  marketing: Megaphone,
  "marketing-e-commerce-ai-marketing": Megaphone,
  "e-commerce": ShoppingCart,
  business: Briefcase,
  "business-tools": Briefcase,
  "business-tools-analytics-marketing": ChartBar,
  sales: CircleDollarSign,
  "sales-assistant": BadgeDollarSign,
  "startup-assistant": Rocket,
  seo: Search,
  "search-engine": Search,
  "social-media": Share2,

  // 数据 / 分析
  analytics: ChartBar,
  "data-analysis": ChartLine,
  "data-platform": Database,
  "spreadsheet-assistant": Table2,
  "churn-management": ChartLine,

  // 音频 / 音乐 / 语音
  "audio-generation": Music,
  "audio-generators": Music,
  "audio-editing": Volume2,
  "audio-music": Music,
  "audio-tool": Volume2,
  "music-generation": Music2,
  "music-generator": Music2,
  "voice-generation": Mic,
  "voice-speech": Mic,
  "text-to-speech": MicVocal,
  transcriber: Captions,

  // 生活方式
  beauty: Paintbrush,
  fashion: Shirt,
  "fashion-assistant": Shirt,
  lifestyle: Sprout,
  health: Heart,
  fitness: Dumbbell,
  sports: CircleDot,
  "fun-tools": Smile,
  "gift-ideas": Gift,
  travel: Plane,
  "real-estate": Home,
  religion: BookOpen,
  gaming: Gamepad2,

  // 协作 / 客服 / HR
  "collaboration-tools": UsersRound,
  hr: UsersRound,
  "hr-tech": UsersRound,
  "human-resources": UsersRound,
  "personal-assistant": UserRoundCheck,
  "customer-support": Headset,
  "email-assistant": Mail,
  "ticketing-management": Ticket,

  // 教育 / 研究
  education: GraduationCap,
  "education--learning-assistant": GraduationCap,
  "homework-assistant": BookOpen,
  "learning-assistant": BookOpen,
  "learning-companion": BookOpen,
  research: FlaskConical,
  "research-assistant": FlaskConical,
  students: GraduationCap,
  teachers: GraduationCap,
  legal: Scale,
  testing: TestTube,

  // 生产力 / 时间
  productivity: Zap,
  "project-management": ListChecks,
  "time-management": Timer,

  // 演示 / 表单
  "ppt-tool": Presentation,
  presentation: Presentation,
  presentations: Presentation,
  "online-form": ListChecks,

  // 视频
  video: Film,
  "video-editing": Film,
  "video-generation": Video,
  "video-generators": Video,
  "video-enhancer": MonitorCog,
  "text-to-video": Clapperboard,

  // 检测 / search 类
  "ai-detector": ScanSearch,
  "content-detection": ScanSearch,
  "detection-tool": ScanSearch,

  // 金融
  finance: Landmark,
  "stock-trading": TrendingUp,

  // 其他内容形态
  storyteller: BookOpen,
  "misc-tools": CircleEllipsis,
};

const FALLBACK_ICON: IconComponent = CircleEllipsis;

interface Props {
  /** category slug */
  slug: string;
  /** 字号 (px)；默认随 className 控制 */
  size?: number;
  className?: string;
}

export function CategoryIcon({ slug, size, className }: Props) {
  const Icon = CATEGORY_ICONS[slug] ?? FALLBACK_ICON;
  return <Icon size={size} className={className} aria-hidden />;
}

/** 当上层只有 (icon, name) 信息时（兼容旧 chip 渲染） */
export function CategoryIconOrEmoji({
  slug,
  icon: _icon,
  size,
  className,
}: Props & { icon?: string | null }) {
  // 旧 emoji 已被替换为图标组件，永远按 slug 取。
  return <CategoryIcon slug={slug} size={size} className={className} />;
}

/** 全部 slug 列表，用于检查覆盖率 */
export const KNOWN_CATEGORY_SLUGS = new Set(Object.keys(CATEGORY_ICONS));
