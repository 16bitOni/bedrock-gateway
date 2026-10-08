// Recharts wrappers themed with the CSS tokens.
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { compact, int, money, shortDate } from "../format";
import { useChartColors } from "../theme";

interface TipPayload {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

function Tip({
  active,
  payload,
  label,
  fmt,
}: {
  active?: boolean;
  payload?: TipPayload[];
  label?: string;
  fmt: (key: string, v: number) => string;
}) {
  if (!active || !payload || !payload.length) return null;
  const rows = payload.filter((p) => p.value !== undefined && p.value !== null && !(p.value === 0 && payload.length > 6));
  return (
    <div className="chart-tip">
      <div className="tip-title">{label ? shortDate(label) : ""}</div>
      {rows.map((p) => (
        <div className="tip-row" key={String(p.dataKey)}>
          <span className="truncate" style={{ maxWidth: 220 }}>
            <i className="swatch" style={{ background: p.color }} />
            {p.name}
          </span>
          <span>{fmt(String(p.dataKey), Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

function tickDate(v: string) {
  return shortDate(v);
}

export function UsageChart({
  data,
  metric,
}: {
  data: { date: string; cost: number; requests: number; input_tokens?: number; output_tokens?: number; errors?: number }[];
  metric: "cost" | "requests" | "tokens";
}) {
  const c = useChartColors();
  const interval = data.length > 45 ? Math.ceil(data.length / 10) : data.length > 14 ? Math.ceil(data.length / 8) : 0;
  const fmt = (k: string, v: number) => (k === "cost" ? money(v) : k === "requests" || k === "errors" ? int(v) : compact(v));
  const empty = data.every((d) => !d.cost && !d.requests && !d.input_tokens && !d.output_tokens);
  return (
    <div className="chart chart-wrap">
      {empty && (
        <div className="chart-empty">
          <span>No usage in this period</span>
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={c.grid} />
          <XAxis dataKey="date" tickFormatter={tickDate} tick={{ fill: c.muted }} axisLine={false} tickLine={false} interval={interval} minTickGap={8} />
          <YAxis
            width={metric === "cost" ? 58 : 44}
            tick={{ fill: c.muted }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => (metric === "cost" ? (v === 0 ? "$0" : money(v)) : compact(v))}
            allowDecimals={metric !== "requests"}
          />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.6 }} content={<Tip fmt={fmt} />} />
          {metric === "cost" && <Bar dataKey="cost" name="Cost" fill={c.accent} radius={[2, 2, 0, 0]} maxBarSize={22} />}
          {metric === "requests" && (
            <>
              <Bar dataKey="requests" name="Requests" fill={c.accent} radius={[2, 2, 0, 0]} maxBarSize={22} />
              <Line dataKey="errors" name="Errors" stroke={c.err} dot={false} strokeWidth={1.5} type="monotone" />
            </>
          )}
          {metric === "tokens" && (
            <>
              <Area dataKey="input_tokens" name="Input tokens" stackId="t" fill={c.accent} fillOpacity={0.25} stroke={c.accent} type="monotone" />
              <Area dataKey="output_tokens" name="Output tokens" stackId="t" fill={c.info} fillOpacity={0.25} stroke={c.info} type="monotone" />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StackedCostChart({
  data,
  keys,
  height,
}: {
  data: Record<string, number | string>[];
  keys: string[];
  height?: number;
}) {
  const c = useChartColors();
  const interval = data.length > 45 ? Math.ceil(data.length / 10) : data.length > 14 ? Math.ceil(data.length / 8) : 0;
  return (
    <div className="chart" style={height ? { height } : undefined}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={c.grid} />
          <XAxis dataKey="date" tickFormatter={tickDate} tick={{ fill: c.muted }} axisLine={false} tickLine={false} interval={interval} minTickGap={8} />
          <YAxis width={58} tick={{ fill: c.muted }} axisLine={false} tickLine={false} tickFormatter={(v: number) => (v === 0 ? "$0" : money(v))} />
          <Tooltip cursor={{ fill: c.grid, opacity: 0.6 }} content={<Tip fmt={(_k, v) => money(v)} />} />
          {keys.map((k, i) => (
            <Bar key={k} dataKey={k} name={k} stackId="s" fill={c.palette[i % c.palette.length]} maxBarSize={22} radius={i === keys.length - 1 ? [2, 2, 0, 0] : 0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
