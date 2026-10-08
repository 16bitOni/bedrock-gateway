import { useSearchParams } from "react-router-dom";
import { ArrowDownWideNarrow, AudioLines, Binary, Columns3, ImageIcon, MessageSquare, Mic } from "lucide-react";
import { useDocumentTitle } from "../../hooks";
import { useInfo } from "../../components/Layout";
import { useV1Models } from "../../components/ModelPicker";
import { ErrorBanner, PageHeader, Tabs } from "../../components/ui";
import { ChatMode } from "./ChatMode";
import { CompareMode } from "./CompareMode";
import { ImageMode, SpeechMode, TranscribeMode } from "./MediaModes";
import { EmbeddingsMode, RerankMode } from "./VectorModes";

type Mode = "chat" | "compare" | "image" | "speech" | "transcribe" | "embeddings" | "rerank";
const MODES: { value: Mode; label: string; icon: React.ReactNode }[] = [
  { value: "chat", label: "Chat", icon: <MessageSquare /> },
  { value: "compare", label: "Compare", icon: <Columns3 /> },
  { value: "image", label: "Image", icon: <ImageIcon /> },
  { value: "speech", label: "Speech", icon: <AudioLines /> },
  { value: "transcribe", label: "Transcribe", icon: <Mic /> },
  { value: "embeddings", label: "Embeddings", icon: <Binary /> },
  { value: "rerank", label: "Rerank", icon: <ArrowDownWideNarrow /> },
];

export function Playground() {
  useDocumentTitle("Playground");
  const [search, setSearch] = useSearchParams();
  const raw = search.get("mode") as Mode | null;
  const mode: Mode = search.get("replay") ? "chat" : raw && MODES.some((m) => m.value === raw) ? raw : "chat";
  const { models, error } = useV1Models();
  const { info } = useInfo();
  const baseUrl = info?.openai_base_url || `${window.location.origin}/v1`;

  return (
    <div className="page wide">
      <PageHeader title="Playground" sub="Every call goes through the gateway as the built-in Playground key — logged, priced and budgeted like real traffic." />
      <div className="mb-12">
        <Tabs
          value={mode}
          tabs={MODES}
          onChange={(m) => {
            const next = new URLSearchParams(search);
            next.set("mode", m);
            setSearch(next, { replace: true });
          }}
        />
      </div>
      {error && (
        <div className="mb-12">
          <ErrorBanner error={`Couldn't load models: ${error}`} />
        </div>
      )}
      <div className={mode === "chat" ? "" : "hidden"}>
        <ChatMode models={models} baseUrl={baseUrl} />
      </div>
      {mode === "compare" && <CompareMode models={models} />}
      {mode === "image" && <ImageMode models={models} />}
      {mode === "speech" && <SpeechMode />}
      {mode === "transcribe" && <TranscribeMode models={models} />}
      {mode === "embeddings" && <EmbeddingsMode models={models} />}
      {mode === "rerank" && <RerankMode models={models} />}
    </div>
  );
}
