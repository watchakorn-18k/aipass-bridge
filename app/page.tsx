"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Sparkles,
  Send,
  Square,
  RefreshCw,
  Settings2,
  Plus,
  MessageSquare,
  Search,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Brain,
  Globe,
  Terminal,
  Cpu,
  Check,
  Copy,
  AlertCircle,
  ShieldCheck,
  Zap,
  Activity,
  Layers,
  Menu,
  X
} from "lucide-react";

interface Model {
  id: string;
  name: string;
  provider: string | null;
  free_credit?: boolean;
  free?: boolean;
  thinking?: string[] | null;
}

interface Conversation {
  id: string;
  title: string;
  updatedAt?: string;
}

interface BridgeStatus {
  ok: boolean;
  directMode?: boolean;
  extensions?: number;
  activeJobs?: number;
  defaultModel?: string;
  conversation?: string | null;
  models?: Model[];
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  tools?: string[];
  sources?: { title?: string; url: string }[];
  isStreaming?: boolean;
  timestamp: string;
}

export default function Dashboard() {
  const [bridgeUrl, setBridgeUrl] = useState<string>("http://157.85.96.7:8787");
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("gemini-3.1-flash-lite");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [latency, setLatency] = useState<number | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [cookieInput, setCookieInput] = useState<string>("");
  const [cookieSaved, setCookieSaved] = useState<boolean>(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Load saved bridge url from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("aipass_bridge_url");
    if (saved) setBridgeUrl(saved);
  }, []);

  // Fetch Bridge status, models, conversations
  const fetchStatus = async () => {
    const start = performance.now();
    try {
      const res = await fetch(`${bridgeUrl}/status`, { cache: "no-store" });
      if (res.ok) {
        const data: BridgeStatus = await res.json();
        setStatus(data);
        setLatency(Math.round(performance.now() - start));
        if (data.defaultModel && !selectedModel) {
          setSelectedModel(data.defaultModel);
        }
      } else {
        setStatus(null);
        setLatency(null);
      }
    } catch {
      setStatus(null);
      setLatency(null);
    }
  };

  const fetchModels = async () => {
    try {
      const res = await fetch(`${bridgeUrl}/v1/models`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.data)) {
          setModels(data.data);
          if (!selectedModel && data.data.length > 0) {
            setSelectedModel(data.data[0].id);
          }
        }
      }
    } catch {}
  };

  const fetchConversations = async () => {
    try {
      const res = await fetch(`${bridgeUrl}/conversations`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.conversations)) {
          setConversations(data.conversations);
          if (data.current && !activeConversationId) {
            setActiveConversationId(data.current);
          }
        }
      }
    } catch {}
  };

  useEffect(() => {
    fetchStatus();
    fetchModels();
    fetchConversations();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [bridgeUrl]);

  // Scroll to bottom on message update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isGenerating]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`;
    }
  }, [inputMessage]);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleReasoning = (msgId: string) => {
    setExpandedReasoning((prev) => ({
      ...prev,
      [msgId]: !prev[msgId],
    }));
  };

  const handleNewChat = async () => {
    try {
      const res = await fetch(`${bridgeUrl}/conversations/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, message: "New conversation." }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.id) {
          setActiveConversationId(data.id);
        }
      }
    } catch {}
    setMessages([]);
    fetchConversations();
  };

  const handleSelectConversation = (id: string) => {
    setActiveConversationId(id);
    fetch(`${bridgeUrl}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation: id }),
    }).catch(() => {});
    setMessages([]);
    setSidebarOpen(false);
  };

  const handleSaveSettings = async () => {
    localStorage.setItem("aipass_bridge_url", bridgeUrl);
    if (cookieInput.trim()) {
      try {
        const res = await fetch(`${bridgeUrl}/cookie`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cookie: cookieInput.trim() }),
        });
        if (res.ok) {
          setCookieSaved(true);
          setTimeout(() => setCookieSaved(false), 3000);
        }
      } catch {}
    }
    fetchStatus();
    fetchModels();
    setShowSettings(false);
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsGenerating(false);
  };

  const handleSend = async (customPrompt?: string) => {
    const textToSend = (customPrompt || inputMessage).trim();
    if (!textToSend || isGenerating) return;

    const userMsgId = `user-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now()}`;
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const newUserMessage: Message = {
      id: userMsgId,
      role: "user",
      content: textToSend,
      timestamp: now,
    };

    const newAssistantMessage: Message = {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      reasoning: "",
      tools: [],
      sources: [],
      isStreaming: true,
      timestamp: now,
    };

    setMessages((prev) => [...prev, newUserMessage, newAssistantMessage]);
    setInputMessage("");
    setIsGenerating(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch(`${bridgeUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          stream: true,
          messages: [{ role: "user", content: textToSend }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${await response.text()}`);
      }

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      let currentContent = "";
      let currentReasoning = "";
      const currentTools: string[] = [];
      const currentSources: { title?: string; url: string }[] = [];

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let cutIndex;

        while ((cutIndex = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, cutIndex);
          buffer = buffer.slice(cutIndex + 2);

          const lines = frame.split("\n").filter((l) => l.startsWith("data:"));
          const dataStr = lines.map((l) => l.slice(5).trim()).join("");

          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) {
              throw new Error(parsed.error.message);
            }

            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              if (delta.reasoning_content) {
                // Check if reasoning contains tool activity or sources
                if (delta.reasoning_content.startsWith("[web_search]") || delta.reasoning_content.includes("returned")) {
                  currentTools.push(delta.reasoning_content.trim());
                } else if (delta.reasoning_content.includes("sources:")) {
                  // extract sources
                  const sourceLines = delta.reasoning_content.split("\n");
                  for (const line of sourceLines) {
                    const match = line.match(/- (.*?) (https?:\/\/[^\s]+)/);
                    if (match) {
                      currentSources.push({ title: match[1].trim(), url: match[2].trim() });
                    }
                  }
                } else {
                  currentReasoning += delta.reasoning_content;
                }
              }

              if (delta.content) {
                currentContent += delta.content;
              }

              // Update message in state
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === assistantMsgId
                    ? {
                        ...msg,
                        content: currentContent,
                        reasoning: currentReasoning,
                        tools: [...currentTools],
                        sources: [...currentSources],
                        isStreaming: true,
                      }
                    : msg
                )
              );
            }
          } catch (e: any) {
            if (e.message) throw e;
          }
        }
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId
            ? {
                ...msg,
                isStreaming: false,
              }
            : msg
        )
      );
      fetchConversations();
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  content: `❌ Error: ${err.message || "Failed to communicate with bridge"}`,
                  isStreaming: false,
                }
              : msg
          )
        );
      }
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  const filteredConversations = conversations.filter((c) =>
    (c.title || c.id).toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedModelObj = models.find((m) => m.id === selectedModel);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100 font-sans">
      {/* ---------------- MOBILE SIDEBAR OVERLAY ---------------- */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ---------------- SIDEBAR ---------------- */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-zinc-800/80 bg-zinc-900/95 transition-transform duration-200 lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-0 max-lg:-translate-x-full"
        }`}
      >
        {/* Brand & New Chat */}
        <div className="flex flex-col gap-3 p-4 border-b border-zinc-800/80">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-blue-600 to-cyan-400 text-white shadow-lg shadow-blue-500/20">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-sm font-semibold tracking-tight text-white flex items-center gap-1.5">
                  AIPass Bridge
                  <span className="rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-400 border border-blue-500/20">
                    v0.1
                  </span>
                </h1>
                <p className="text-xs text-zinc-400">AI Control Dashboard</p>
              </div>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 lg:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <button
            onClick={handleNewChat}
            className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 py-2.5 px-4 text-sm font-medium text-white shadow-md shadow-blue-600/20 transition-all hover:brightness-110 active:scale-[0.99]"
          >
            <Plus className="h-4 w-4" />
            <span>New Chat</span>
          </button>
        </div>

        {/* Search Conversations */}
        <div className="px-4 py-2">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg bg-zinc-800/60 pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 border border-zinc-700/40 focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Conversation List */}
        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5 scrollbar-thin scrollbar-thumb-zinc-800">
          <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Recent Conversations ({filteredConversations.length})
          </div>

          {filteredConversations.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-zinc-500">
              No conversations found
            </div>
          ) : (
            filteredConversations.map((conv) => {
              const isActive = activeConversationId === conv.id;
              return (
                <button
                  key={conv.id}
                  onClick={() => handleSelectConversation(conv.id)}
                  className={`group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs transition-colors ${
                    isActive
                      ? "bg-blue-600/15 text-blue-400 font-medium border border-blue-500/30"
                      : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                  }`}
                >
                  <MessageSquare
                    className={`h-3.5 w-3.5 shrink-0 ${
                      isActive ? "text-blue-400" : "text-zinc-500 group-hover:text-zinc-400"
                    }`}
                  />
                  <div className="flex-1 truncate">
                    <div className="truncate">{conv.title || conv.id}</div>
                    {conv.updatedAt && (
                      <div className="text-[10px] text-zinc-500 truncate">
                        {conv.updatedAt.slice(0, 16)}
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Bridge Status Widget */}
        <div className="p-3 border-t border-zinc-800/80 bg-zinc-950/40">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                {status?.ok ? (
                  <>
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                  </>
                ) : (
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
                )}
              </span>
              <span className="text-xs font-medium text-zinc-300">
                {status?.ok ? (status.directMode ? "Direct Headless" : "Extension Linked") : "Disconnected"}
              </span>
            </div>

            <button
              onClick={() => setShowSettings(true)}
              className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              title="Bridge Settings"
            >
              <Settings2 className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span className="truncate max-w-[140px]">{bridgeUrl.replace(/^https?:\/\//, "")}</span>
            {latency !== null && (
              <span className="flex items-center gap-1 text-emerald-400 font-mono text-[10px]">
                <Activity className="h-3 w-3" /> {latency}ms
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* ---------------- MAIN CONTENT CHAT AREA ---------------- */}
      <main className="flex flex-1 flex-col overflow-hidden bg-zinc-950">
        {/* Top Header */}
        <header className="flex h-16 items-center justify-between border-b border-zinc-800/80 px-4 lg:px-6 bg-zinc-900/50 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>

            {/* Model Selector Dropdown */}
            <div className="relative">
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="appearance-none bg-zinc-800/80 hover:bg-zinc-800 text-zinc-100 text-xs font-medium pl-3.5 pr-8 py-2 rounded-xl border border-zinc-700/50 shadow-xs focus:outline-hidden focus:ring-1 focus:ring-blue-500 cursor-pointer"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id} className="bg-zinc-900 text-zinc-100 py-1">
                    {m.name || m.id} {m.free || m.free_credit ? "[Free]" : ""}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-3 h-3.5 w-3.5 text-zinc-400" />
            </div>

            {selectedModelObj && (
              <div className="hidden sm:flex items-center gap-1.5">
                {selectedModelObj.free || selectedModelObj.free_credit ? (
                  <span className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                    <Zap className="h-3 w-3" /> Free Credit
                  </span>
                ) : null}
                {selectedModelObj.provider && (
                  <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 border border-zinc-700/40">
                    {selectedModelObj.provider}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                fetchStatus();
                fetchModels();
                fetchConversations();
              }}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 border border-zinc-700/40 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </header>

        {/* Chat Messages List */}
        <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6 scrollbar-thin scrollbar-thumb-zinc-800">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center max-w-xl mx-auto px-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 to-cyan-500 text-white shadow-xl shadow-blue-500/20 mb-5">
                <Sparkles className="h-8 w-8" />
              </div>
              <h2 className="text-xl font-bold tracking-tight text-white mb-2">
                AIPass Bridge Dashboard
              </h2>
              <p className="text-sm text-zinc-400 mb-8 leading-relaxed">
                Connect and stream multi-model LLMs with server-side tools, web search reasoning, and autonomous coding tools.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full">
                {[
                  { label: "สรุปข่าวเทคโนโลยีวันนี้", icon: Globe },
                  { label: "เขียนโค้ด React Component", icon: Terminal },
                  { label: "อธิบายทฤษฎีควอนตัมสั้นๆ", icon: Brain },
                  { label: "วิเคราะห์และแก้บั๊กโค้ด", icon: Cpu },
                ].map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSend(item.label)}
                    className="flex items-center gap-3 rounded-xl bg-zinc-900/80 p-3.5 text-left text-xs text-zinc-300 border border-zinc-800 hover:border-blue-500/50 hover:bg-zinc-800/60 transition-all group"
                  >
                    <item.icon className="h-4 w-4 text-blue-400 group-hover:scale-110 transition-transform shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col gap-2 max-w-3xl mx-auto ${
                  msg.role === "user" ? "items-end" : "items-start"
                }`}
              >
                {/* Message Header info */}
                <div className="flex items-center gap-2 px-1 text-[11px] text-zinc-500">
                  <span>{msg.role === "user" ? "You" : selectedModelObj?.name || "Assistant"}</span>
                  <span>•</span>
                  <span>{msg.timestamp}</span>
                </div>

                {/* Message Bubble */}
                <div
                  className={`relative group rounded-2xl px-4 py-3.5 text-sm leading-relaxed max-w-full sm:max-w-[90%] shadow-sm ${
                    msg.role === "user"
                      ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-br-xs"
                      : "bg-zinc-900 border border-zinc-800/80 text-zinc-100 rounded-bl-xs w-full"
                  }`}
                >
                  {/* Reasoning Collapsible Section */}
                  {msg.reasoning && (
                    <div className="mb-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 overflow-hidden">
                      <button
                        onClick={() => toggleReasoning(msg.id)}
                        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800/40 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <Brain className="h-3.5 w-3.5 text-purple-400" />
                          <span>Thinking Process</span>
                        </div>
                        {expandedReasoning[msg.id] ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                      {expandedReasoning[msg.id] && (
                        <div className="px-3 pb-3 pt-1 text-xs font-mono text-zinc-400 whitespace-pre-wrap leading-relaxed border-t border-zinc-800/40">
                          {msg.reasoning}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Tool Badges */}
                  {msg.tools && msg.tools.length > 0 && (
                    <div className="mb-3 space-y-1">
                      {msg.tools.map((tool, tidx) => (
                        <div
                          key={tidx}
                          className="flex items-center gap-2 rounded-lg bg-blue-500/10 px-2.5 py-1 text-xs text-blue-300 border border-blue-500/20 font-mono"
                        >
                          <Globe className="h-3 w-3 text-blue-400" />
                          <span className="truncate">{tool}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Main Content */}
                  <div className="whitespace-pre-wrap break-words">
                    {msg.content || (msg.isStreaming ? (
                      <span className="inline-flex items-center gap-1 text-zinc-400 animate-pulse">
                        <span className="h-2 w-2 rounded-full bg-blue-400"></span>
                        Generating answer...
                      </span>
                    ) : (
                      ""
                    ))}
                    {msg.isStreaming && msg.content && (
                      <span className="inline-block h-4 w-1.5 bg-blue-400 animate-pulse ml-0.5 align-middle" />
                    )}
                  </div>

                  {/* Sources List */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-zinc-800/80">
                      <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <Globe className="h-3.5 w-3.5 text-cyan-400" />
                        <span>Sources Cited ({msg.sources.length})</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {msg.sources.map((src, sidx) => (
                          <a
                            key={sidx}
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-800 px-2.5 py-1 text-xs text-cyan-400 hover:text-cyan-300 border border-zinc-700/50 transition-colors"
                          >
                            <ExternalLink className="h-3 w-3" />
                            <span className="max-w-[200px] truncate">{src.title || src.url}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Copy Button */}
                  {msg.content && !msg.isStreaming && (
                    <button
                      onClick={() => handleCopy(msg.content, msg.id)}
                      className="absolute bottom-2 right-2 rounded-lg bg-zinc-800/70 hover:bg-zinc-700 p-1.5 text-zinc-400 hover:text-zinc-200 opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Copy text"
                    >
                      {copiedId === msg.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Chat Input Area */}
        <div className="border-t border-zinc-800/80 p-4 lg:p-5 bg-zinc-900/40 backdrop-blur-md">
          <div className="max-w-3xl mx-auto">
            <div className="relative flex items-end rounded-2xl bg-zinc-900 border border-zinc-700/60 shadow-lg focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 transition-all">
              <textarea
                ref={textareaRef}
                rows={1}
                placeholder={`Message ${selectedModelObj?.name || "AI"}... (Shift+Enter for newline)`}
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                className="w-full resize-none bg-transparent px-4 py-3.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-hidden max-h-44"
              />

              <div className="flex items-center gap-1.5 p-2 shrink-0">
                {isGenerating ? (
                  <button
                    onClick={handleStop}
                    className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-500/30 transition-all"
                    title="Stop generation"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </button>
                ) : (
                  <button
                    onClick={() => handleSend()}
                    disabled={!inputMessage.trim()}
                    className={`flex h-9 w-9 items-center justify-center rounded-xl transition-all ${
                      inputMessage.trim()
                        ? "bg-blue-600 text-white shadow-md shadow-blue-500/20 hover:bg-blue-500 active:scale-95 cursor-pointer"
                        : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    }`}
                  >
                    <Send className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between mt-2 px-1 text-[11px] text-zinc-500">
              <span>Bridge Server: <span className="text-zinc-400 font-mono">{bridgeUrl}</span></span>
              <span>OpenAI API Compatible: <span className="text-blue-400 font-mono">/v1/chat/completions</span></span>
            </div>
          </div>
        </div>
      </main>

      {/* ---------------- SETTINGS MODAL ---------------- */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-lg rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-blue-400" />
                <h3 className="text-base font-semibold text-white">Bridge Server Settings</h3>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Bridge URL */}
              <div>
                <label className="block font-medium text-zinc-300 mb-1.5">
                  Bridge Server Host URL
                </label>
                <input
                  type="text"
                  value={bridgeUrl}
                  onChange={(e) => setBridgeUrl(e.target.value)}
                  placeholder="http://157.85.96.7:8787"
                  className="w-full rounded-xl bg-zinc-950 border border-zinc-700/60 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:border-blue-500 focus:outline-hidden"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  Default: <code className="font-mono text-zinc-400">http://157.85.96.7:8787</code> or <code className="font-mono text-zinc-400">http://127.0.0.1:8787</code>
                </p>
              </div>

              {/* Cookie Session Input */}
              <div>
                <label className="block font-medium text-zinc-300 mb-1.5">
                  Update Session Cookie (for Direct Headless Mode)
                </label>
                <textarea
                  rows={3}
                  value={cookieInput}
                  onChange={(e) => setCookieInput(e.target.value)}
                  placeholder="Paste Cookie string from browser Network tab..."
                  className="w-full rounded-xl bg-zinc-950 border border-zinc-700/60 p-3 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-hidden"
                />
                <p className="text-[11px] text-zinc-500 mt-1">
                  Submitting this will update the server's session token instantly without restarting.
                </p>
              </div>

              {/* Status Diagnostic summary */}
              <div className="rounded-xl bg-zinc-950/60 p-3.5 border border-zinc-800 space-y-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Connection Status:</span>
                  <span className={status?.ok ? "text-emerald-400 font-medium" : "text-red-400"}>
                    {status?.ok ? "Connected" : "Not Reachable"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Operating Mode:</span>
                  <span className="text-zinc-300 font-medium">
                    {status?.directMode ? "Direct Headless (Cookie)" : "Extension Linked"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Discovered Models:</span>
                  <span className="text-zinc-300 font-mono">{models.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Active Conversation ID:</span>
                  <span className="text-zinc-300 font-mono truncate max-w-[200px]">
                    {activeConversationId || status?.conversation || "None"}
                  </span>
                </div>
              </div>

              {cookieSaved && (
                <div className="flex items-center gap-2 text-emerald-400 text-xs">
                  <Check className="h-4 w-4" /> Cookie updated successfully on the server!
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-800">
              <button
                onClick={() => setShowSettings(false)}
                className="rounded-xl px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveSettings}
                className="rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-2 text-xs font-medium text-white shadow-md shadow-blue-500/20 transition-all active:scale-95"
              >
                Save & Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

