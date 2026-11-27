"""Self-contained interactive HTML exporter for Pro BI Dashboards & single-turn Analytical Reports."""

from __future__ import annotations

import html
import json
import re
from datetime import UTC, datetime
from typing import Any

from app.models import SourceDetail

ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js"

_SQL_CLAUSES = {"SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET", "WITH", "UNION", "INTERSECT", "EXCEPT"}
_SQL_FUNCS = {"SUM", "COUNT", "AVG", "MIN", "MAX", "ROUND", "CAST", "TRY_CAST", "COALESCE", "NULLIF", "STRFTIME", "DATE_TRUNC", "LOWER", "UPPER", "ROW_NUMBER", "RANK", "LAG", "LEAD"}
_SQL_OPS = {"AS", "ON", "AND", "OR", "NOT", "IN", "IS", "NULL", "CASE", "WHEN", "THEN", "ELSE", "END", "DISTINCT", "ALL", "DESC", "ASC", "OVER", "PARTITION", "BETWEEN", "LIKE", "ILIKE", "DATE", "TIMESTAMP", "VARCHAR"}
_SQL_TOK_RE = re.compile(r"(--.*$|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)")


def _highlight_sql_block(sql_text: str) -> str:
    """Render a line-numbered, syntax-highlighted dark IDE SQL block for standalone HTML."""
    lines_html: list[str] = []
    for idx, line in enumerate((sql_text or "").replace("\r\n", "\n").split("\n"), start=1):
        out, pos, prev = [], 0, ""
        for m in _SQL_TOK_RE.finditer(line):
            if m.start() > pos:
                out.append(html.escape(line[pos : m.start()]))
            tok, up = m.group(0), m.group(0).upper()
            esc_tok = html.escape(tok)
            if tok.startswith("--"):
                out.append(f"<span class='sc'>{esc_tok}</span>")
                prev = ""
            elif tok.startswith("'"):
                out.append(f"<span class='ss'>{esc_tok}</span>")
                prev = ""
            elif tok.startswith('"'):
                out.append(f"<span class='sa'>{esc_tok}</span>")
                prev = ""
            elif tok[0].isdigit():
                out.append(f"<span class='sn'>{esc_tok}</span>")
                prev = ""
            elif up in _SQL_CLAUSES:
                out.append(f"<span class='sk'>{esc_tok}</span>")
                prev = up
            elif up in _SQL_FUNCS:
                out.append(f"<span class='sf'>{esc_tok}</span>")
                prev = up
            elif up in _SQL_OPS:
                out.append(f"<span class='so'>{esc_tok}</span>")
                prev = up
            elif prev == "AS":
                out.append(f"<span class='sa'>{esc_tok}</span>")
                prev = ""
            else:
                out.append(esc_tok)
                prev = ""
            pos = m.end()
        if pos < len(line):
            out.append(html.escape(line[pos:]))
        body = "".join(out) or "&nbsp;"
        lines_html.append(f"<div class='sl'><span class='sln'>{idx}</span><span class='slc'>{body}</span></div>")
    return f"<div class='sql-box'><code>{''.join(lines_html)}</code></div>"


def _safe_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str).replace("</", "<\\/")


def _md_to_html(md_text: str) -> str:
    if not (md_text or "").strip():
        return "<p class='muted'>暂无分析结论。</p>"
    out, code_buf, list_tag, in_code = [], [], "", False

    def close_list() -> None:
        nonlocal list_tag
        if list_tag:
            out.append(f"</{list_tag}>")
            list_tag = ""

    def inline(text: str) -> str:
        s = re.sub(r"\[ref:([A-Za-z0-9_\-]+)\]", r"<span class='ref-pill'>\1</span>", html.escape(text))
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        return re.sub(r"\*([^*]+)\*", r"<em>\1</em>", re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s))

    raw_lines = md_text.replace("\r\n", "\n").split("\n")
    idx = 0
    while idx < len(raw_lines):
        raw = raw_lines[idx]
        s = raw.strip()
        if s.startswith("```"):
            close_list()
            if in_code:
                out.append(f"<pre><code>{html.escape(chr(10).join(code_buf))}</code></pre>")
                code_buf.clear()
            in_code = not in_code
            idx += 1
        elif in_code:
            code_buf.append(raw)
            idx += 1
        elif (
            "|" in s
            and idx + 1 < len(raw_lines)
            and re.match(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$", raw_lines[idx + 1])
        ):
            close_list()

            def _split_row(line_str: str) -> list[str]:
                return [c.strip() for c in re.sub(r"^\||\|$", "", line_str.strip()).split("|")]

            headers = _split_row(s)
            body_rows: list[list[str]] = []
            idx += 2
            while idx < len(raw_lines) and "|" in raw_lines[idx].strip():
                body_rows.append(_split_row(raw_lines[idx]))
                idx += 1
            ths = "".join(f"<th>{inline(h)}</th>" for h in headers)
            trs = "".join(
                "<tr>" + "".join(f"<td>{inline(r[ci] if ci < len(r) else '')}</td>" for ci in range(len(headers))) + "</tr>"
                for r in body_rows
            )
            out.append(f"<div class='table-wrap'><table><thead><tr>{ths}</tr></thead><tbody>{trs}</tbody></table></div>")
        elif not s:
            close_list()
            idx += 1
        elif m := re.match(r"^(#{1,4})\s+(.*)$", s):
            close_list()
            lvl = min(len(m.group(1)) + 1, 5)
            out.append(f"<h{lvl}>{inline(m.group(2))}</h{lvl}>")
            idx += 1
        elif m := re.match(r"^(?:([-*•])|(\d+\.))\s+(.*)$", s):
            want = "ul" if m.group(1) else "ol"
            if list_tag != want:
                close_list()
                out.append(f"<{want}>")
                list_tag = want
            out.append(f"<li>{inline(m.group(3))}</li>")
            idx += 1
        else:
            close_list()
            out.append(f"<p>{inline(s)}</p>")
            idx += 1
    if in_code and code_buf:
        out.append(f"<pre><code>{html.escape(chr(10).join(code_buf))}</code></pre>")
    close_list()
    return "\n".join(out)


def _table_html(columns: list[str], rows: list[dict[str, Any]], max_rows: int = 50) -> str:
    if not columns or not rows:
        return "<div class='empty-state'>暂无数据行</div>"
    ths = "".join(f"<th>{html.escape(str(c))}</th>" for c in columns)
    trs = "".join("<tr>" + "".join(f"<td>{html.escape('' if r.get(c) is None else str(r.get(c)))}</td>" for c in columns) + "</tr>" for r in rows[:max_rows])
    more = f"<div class='table-note'>展示前 {max_rows} 行，共 {len(rows)} 行</div>" if len(rows) > max_rows else ""
    return f"<div class='table-wrap'><table><thead><tr>{ths}</tr></thead><tbody>{trs}</tbody></table></div>{more}"


def _theme_css(theme: str) -> str:
    vars_ = (
        "--bg:#020617;--card:#0f172a;--bd:#1e293b;--fg:#f8fafc;--muted:#94a3b8;--acc:#38bdf8;--code:#020617;--pill:rgba(56,189,248,.14);--sh:0 8px 30px rgba(0,0,0,.35)"
        if theme == "dark"
        else "--bg:#f8fafc;--card:#ffffff;--bd:#e2e8f0;--fg:#0f172a;--muted:#64748b;--acc:#2563eb;--code:#f1f5f9;--pill:#eff6ff;--sh:0 2px 10px rgba(15,23,42,.05)"
    )
    return (
        f":root{{{vars_}}}*{{box-sizing:border-box}}"
        'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg);line-height:1.55}'
        ".page{max-width:1440px;margin:0 auto;padding:24px 28px 48px}.header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;padding-bottom:18px;margin-bottom:20px;border-bottom:1px solid var(--bd)}"
        ".header h1{margin:0 0 6px;font-size:24px;font-weight:700;letter-spacing:-.02em}.header p{margin:0;color:var(--muted);font-size:14px}.meta-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}"
        ".pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;background:var(--pill);color:var(--acc);border:1px solid var(--bd)}"
        ".bi-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:16px}.span-3{grid-column:span 3/span 3}.span-4{grid-column:span 4/span 4}.span-6{grid-column:span 6/span 6}.span-12{grid-column:span 12/span 12}"
        "@media(max-width:1024px){.span-3,.span-4{grid-column:span 6/span 6}.span-6,.span-12{grid-column:span 12/span 12}}@media(max-width:640px){.span-3,.span-4,.span-6,.span-12{grid-column:span 12/span 12}}"
        ".card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px 18px;box-shadow:var(--sh);display:flex;flex-direction:column;gap:10px}"
        ".card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.card-title{margin:0;font-size:15px;font-weight:600}.card-sub{margin:2px 0 0;font-size:12px;color:var(--muted)}"
        ".chart-box{width:100%;height:300px}.chart-box.kpi{height:auto;min-height:84px}.kpi-box{padding:8px 0 4px}.kpi-value{font-size:32px;font-weight:800;letter-spacing:-.02em;color:var(--acc)}"
        ".kpi-delta{display:inline-block;margin-top:8px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}.delta-up{background:rgba(16,185,129,.16);color:#10b981}.delta-down{background:rgba(239,68,68,.16);color:#ef4444}.delta-flat{background:rgba(148,163,184,.18);color:var(--muted)}.kpi-note{margin-top:6px;font-size:12px;color:var(--muted)}"
        "details{border-top:1px dashed var(--bd);padding-top:8px;font-size:12px}summary{cursor:pointer;color:var(--muted);font-weight:500;user-select:none}pre{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--code);border:1px solid var(--bd);overflow-x:auto;font-size:12px;color:var(--fg)}code{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}"
        ".sql-box{margin:8px 0 0;padding:10px 0;border-radius:10px;background:#0d1117;border:1px solid #1e293b;overflow-x:auto;font-size:12.5px;line-height:1.68;color:#e2e8f0}.sl{display:flex;padding:0 12px 0 0}.sln{min-width:38px;padding:0 10px 0 8px;text-align:right;color:#475569;border-right:1px solid #1e293b;user-select:none}.slc{padding-left:12px;white-space:pre}.sk{color:#7dd3fc;font-weight:700}.sf{color:#c4b5fd;font-weight:600}.so{color:#f9a8d4;font-weight:500}.ss{color:#6ee7b7}.sn{color:#fcd34d}.sa{color:#67e8f9}.sc{color:#64748b;font-style:italic}"
        ".table-wrap{overflow-x:auto;margin-top:8px;border:1px solid var(--bd);border-radius:8px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:7px 10px;border-bottom:1px solid var(--bd);text-align:left;white-space:nowrap}th{background:var(--code);font-weight:600}"
        ".table-note,.muted,.empty-state{color:var(--muted);font-size:12px;padding:6px 0}.ref-pill{display:inline-block;padding:1px 6px;border-radius:6px;background:var(--pill);color:var(--acc);font-family:monospace;font-size:11px}"
        ".section{margin-bottom:22px}.section-title{font-size:16px;font-weight:700;margin:0 0 12px}.trace-item{padding:10px 12px;border:1px solid var(--bd);border-radius:10px;margin-bottom:8px;background:var(--card);font-size:13px}.footer{margin-top:32px;text-align:center;color:var(--muted);font-size:12px}"
        "@media print{body{background:#fff;color:#0f172a}.card{box-shadow:none;break-inside:avoid}details{display:none}}"
    )


def _chart_js() -> str:
    """Shared compact JS renderChart(elId, spec, rows, theme) for all 9 chart types + multi-series."""
    return r"""const __CH__=[],num=v=>{if(v==null||v==='')return 0;const n=Number(String(v).replace(/,/g,''));return Number.isFinite(n)?n:0;};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,u)=>{const n=num(v),a=Math.abs(n),f=a>=1e8?(n/1e8).toFixed(2)+'亿':a>=1e4&&!String(u||'').includes('%')?(n/1e4).toFixed(2)+'万':n.toLocaleString('zh-CN',{maximumFractionDigits:Number.isInteger(n)?0:2});return u?`${f} ${u}`:f;};
function renderChart(elId,spec,rawRows,theme){
  const el=document.getElementById(elId);if(!el||!spec)return;
  let rows=Array.isArray(rawRows)?rawRows.slice():[];
  const s=spec.sort||'none',ct=spec.chart_type||'bar',dark=theme==='dark';
  if(s==='y_desc')rows.sort((a,b)=>num(b[spec.y])-num(a[spec.y]));
  else if(s==='y_asc')rows.sort((a,b)=>num(a[spec.y])-num(b[spec.y]));
  else if(s==='x_asc'&&spec.x)rows.sort((a,b)=>String(a[spec.x]??'').localeCompare(String(b[spec.x]??'')));
  else if(s==='x_desc'&&spec.x)rows.sort((a,b)=>String(b[spec.x]??'').localeCompare(String(a[spec.x]??'')));
  if(spec.top_n>0)rows=rows.slice(0,spec.top_n);
  if(!rows.length){el.innerHTML='<div class="empty-state">当前筛选条件下暂无数据</div>';return;}
  if(ct==='kpi_card'){
    const r=rows[0]||{},hasD=spec.delta_col&&r[spec.delta_col]!=null,dn=hasD?num(r[spec.delta_col]):0;
    const dPct=hasD&&Math.abs(dn)<=1.5&&!String(r[spec.delta_col]).includes('%')?(dn*100).toFixed(2)+'%':`${dn.toFixed(2)}%`;
    const dHtml=hasD?`<div class="kpi-delta ${dn>0?'delta-up':dn<0?'delta-down':'delta-flat'}">${dn>0?'▲':dn<0?'▼':'•'} ${dn>0?'+':''}${esc(dPct)}${spec.delta_label?' '+esc(spec.delta_label):''}</div>`:'';
    el.innerHTML=`<div class="kpi-box"><div class="kpi-value">${esc(fmt(r[spec.y],spec.unit||''))}</div>${dHtml}${spec.metric_note?`<div class="kpi-note">${esc(spec.metric_note)}</div>`:''}</div>`;return;
  }
  if(typeof echarts==='undefined'){el.innerHTML='<div class="empty-state">未能加载 ECharts CDN，请联网查看图表</div>';return;}
  const fg=dark?'#cbd5e1':'#334155',ln=dark?'rgba(148,163,184,.14)':'rgba(15,23,42,.08)';
  const pal=dark?['#38bdf8','#818cf8','#34d399','#fbbf24','#f472b6','#2dd4bf','#fb923c','#a78bfa']:['#2563eb','#0ea5e9','#10b981','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#f97316'];
  const base={color:pal,backgroundColor:'transparent',tooltip:{trigger:['pie','funnel','scatter'].includes(ct)?'item':'axis',backgroundColor:dark?'#0f172a':'#fff',borderColor:dark?'#334155':'#e2e8f0',textStyle:{color:dark?'#f8fafc':'#0f172a'}},grid:{top:36,right:ct==='combo'?56:20,bottom:38,left:56,containLabel:true},legend:{top:0,textStyle:{color:fg,fontSize:12}}};
  let opt;
  if(ct==='pie')opt={...base,legend:{bottom:0,textStyle:{color:fg,fontSize:12}},series:[{name:spec.title||spec.y,type:'pie',radius:['42%','70%'],center:['50%','46%'],itemStyle:{borderRadius:6,borderColor:dark?'#0f172a':'#fff',borderWidth:2},label:{color:fg,formatter:'{b}: {d}%'},data:rows.map(r=>({name:String(r[spec.x]??''),value:num(r[spec.y])}))}]};
  else if(ct==='funnel')opt={...base,series:[{name:spec.title||spec.y,type:'funnel',left:'10%',width:'80%',top:24,bottom:20,sort:'descending',gap:3,label:{show:true,position:'inside',color:'#fff',formatter:'{b}: {c}'},data:rows.map(r=>({name:String(r[spec.x]??''),value:num(r[spec.y])}))}]};
  else if(ct==='scatter')opt={...base,xAxis:{type:'value',name:spec.x||'',axisLabel:{color:fg},splitLine:{lineStyle:{color:ln}}},yAxis:{type:'value',name:spec.unit||spec.y,axisLabel:{color:fg},splitLine:{lineStyle:{color:ln}}},series:[{name:spec.title||spec.y,type:'scatter',symbolSize:12,data:rows.map(r=>[num(r[spec.x]),num(r[spec.y])])}]};
  else if(ct==='combo')opt={...base,xAxis:{type:'category',data:rows.map(r=>String(r[spec.x]??'')),axisLabel:{color:fg}},yAxis:[{type:'value',name:spec.unit||spec.y,axisLabel:{color:fg},splitLine:{lineStyle:{color:ln}}},{type:'value',name:spec.y2_unit||spec.y2||'',axisLabel:{color:fg},splitLine:{show:false}}],series:[{name:spec.y,type:'bar',yAxisIndex:0,barMaxWidth:36,itemStyle:{borderRadius:[4,4,0,0]},data:rows.map(r=>num(r[spec.y]))},{name:spec.y2,type:'line',yAxisIndex:1,smooth:true,symbolSize:7,data:rows.map(r=>num(r[spec.y2]))}]};
  else{
    const horiz=ct==='horizontal_bar',st=ct==='line'||ct==='area'?'line':'bar',xs=[...new Set(rows.map(r=>String(r[spec.x]??'')))];
    const mkS=(name,data,bw)=>({name,type:st,smooth:st==='line',areaStyle:ct==='area'?{opacity:.22}:undefined,barMaxWidth:bw,itemStyle:st==='bar'?{borderRadius:horiz?[0,4,4,0]:[4,4,0,0]}:undefined,data});
    let sl;
    if(spec.series){const gs=[...new Set(rows.map(r=>String(r[spec.series]??'')))],m=new Map();rows.forEach(r=>m.set(`${r[spec.series]}__${r[spec.x]}`,num(r[spec.y])));sl=gs.map(g=>mkS(g,xs.map(x=>m.get(`${g}__${x}`)??0),28));}
    else sl=[mkS(spec.y,rows.map(r=>num(r[spec.y])),38)];
    const cAx={type:'category',data:xs,axisLabel:{color:fg}},vAx={type:'value',name:spec.unit||'',axisLabel:{color:fg},splitLine:{lineStyle:{color:ln}}};
    opt={...base,xAxis:horiz?vAx:cAx,yAxis:horiz?{...cAx,inverse:true}:vAx,series:sl};
  }
  const ch=echarts.init(el);ch.setOption(opt);__CH__.push(ch);
}
window.addEventListener('resize',()=>__CH__.forEach(c=>c.resize()));"""


def _render_page(title: str, theme: str, header_html: str, body_html: str, footer: str, var_name: str, charts: list[dict[str, Any]]) -> str:
    return (
        f'<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>'
        f'<title>{title}</title><script src="{ECHARTS_CDN}"></script><style>{_theme_css(theme)}</style></head>'
        f'<body><main class="page"><header class="header">{header_html}</header>{body_html}<footer class="footer">{footer}</footer></main>'
        f"<script>{_chart_js()}\nconst {var_name}={_safe_json(charts)};{var_name}.forEach(it=>renderChart(it.domId,it.chart_spec,it.rows,{_safe_json(theme)}));</script></body></html>\n"
    )


def _pills(items: list[str]) -> str:
    return "<div class='meta-pills'>" + "".join(f"<span class='pill'>{x}</span>" for x in items) + "</div>"


def export_dashboard_html(
    dashboard: dict[str, Any], source: SourceDetail, filter_values: dict[str, Any] | None = None
) -> str:
    """Export a Pro BI Dashboard into a single standalone interactive HTML file."""
    theme = dashboard.get("theme") if dashboard.get("theme") in {"light", "dark"} else "light"
    cards, exported_at = dashboard.get("cards") or [], datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    meta = [f"数据源: {html.escape(f'{source.name} ({source.dialect.upper()})')}", f"主题: {theme}", f"卡片数: {len(cards)}", f"导出时间: {exported_at}"]
    for k, v in (filter_values or {}).items():
        if v not in (None, "", [], {}):
            val = f"{v.get('start', '')} ~ {v.get('end', '')}" if isinstance(v, dict) else (", ".join(map(str, v)) if isinstance(v, list) else str(v))
            meta.append(f"筛选 {html.escape(str(k))}: {html.escape(val)}")

    card_parts, charts = [], []
    for idx, card in enumerate(cards):
        span = card.get("layout_span") if card.get("layout_span") in {3, 4, 6, 12} else 6
        dom_id, spec, kind = f"dp_chart_{idx}", card.get("chart_spec"), card.get("card_kind", "chart")
        rows, cols = card.get("rows") or [], card.get("columns") or []
        sql_text, applied = card.get("effective_sql") or card.get("sql_text") or "", card.get("applied_filters") or []
        if kind == "table" or not spec:
            content = _table_html(cols, rows, 50)
        else:
            content = f"<div id='{dom_id}' class='chart-box{' kpi' if (spec.get('chart_type') == 'kpi_card' or kind == 'kpi') else ''}'></div>"
            charts.append({"domId": dom_id, "chart_spec": spec, "rows": rows})
        badge = f"<span class='pill'>已下推 {len(applied)} 项筛选</span>" if applied else ""
        sql_block = f"<details><summary>查看白盒 SQL（{len(rows)} 行）</summary>{_highlight_sql_block(sql_text)}</details>" if sql_text else ""
        sub = f"<p class='card-sub'>{html.escape(str(card['subtitle']))}</p>" if card.get("subtitle") else ""
        card_parts.append(f"<article class='card span-{span}'><div class='card-head'><div><h3 class='card-title'>{html.escape(str(card.get('title', '未命名卡片')))}</h3>{sub}</div>{badge}</div>{content}{sql_block}</article>")

    title_esc = html.escape(str(dashboard.get("name", "DataPilot Pro BI 看板")))
    desc_html = f"<p>{html.escape(str(dashboard.get('description')))}</p>" if dashboard.get("description") else ""
    grid = "".join(card_parts) or "<div class='card span-12 empty-state'>当前看板尚无卡片</div>"
    return _render_page(
        f"{title_esc} — DataPilot-Agent BI", theme, f"<div><h1>{title_esc}</h1>{desc_html}{_pills(meta)}</div>",
        f"<section class='bi-grid'>{grid}</section>", "Generated by DataPilot-Agent v2.0 · Glass-Box ReAct BI Engine", "__DASHBOARD_CHARTS__", charts,
    )


def export_turn_report_html(
    turn: dict[str, Any], source: SourceDetail, results_by_id: dict[str, dict[str, Any]]
) -> str:
    """Export a single Agent analytical turn into a standalone interactive HTML report."""
    q_esc = html.escape(str(turn.get("question", "数据分析报告")))
    artifacts, steps = turn.get("artifacts") or [], turn.get("steps") or []
    art_parts, charts = [], []
    for idx, art in enumerate(artifacts):
        rid = str(art.get("result_id") or "")
        res = results_by_id.get(rid, {})
        rows, cols = art.get("rows") or res.get("rows") or [], art.get("columns") or res.get("columns") or []
        sql_text, spec, dom_id = art.get("sql_text") or res.get("sql_text") or "", art.get("chart_spec"), f"dp_art_{idx}"
        chart_html = ""
        if spec:
            chart_html = f"<div id='{dom_id}' class='chart-box{' kpi' if spec.get('chart_type') == 'kpi_card' else ''}'></div>"
            charts.append({"domId": dom_id, "chart_spec": spec, "rows": rows})
        sql_pre = _highlight_sql_block(sql_text) if sql_text else ""
        art_parts.append(
            f"<article class='card span-6'><div class='card-head'><div><h3 class='card-title'>{html.escape(str(art.get('title') or rid or '分析图表'))}</h3>"
            f"<p class='card-sub'>结果收据: {html.escape(rid)} · 共 {len(rows)} 行</p></div></div>{chart_html}"
            f"<details><summary>查看白盒 SQL 与数据明细</summary>{sql_pre}{_table_html(cols, rows, 30)}</details></article>"
        )

    trace_parts = []
    for st in steps:
        thought, sql_s = str(st.get("thought") or "").strip(), str(st.get("sql_text") or "").strip()
        th_h = f"<p class='muted' style='margin:6px 0 0'>{html.escape(thought)}</p>" if thought else ""
        sq_h = f"<details style='margin-top:6px'><summary>执行 SQL</summary>{_highlight_sql_block(sql_s)}</details>" if sql_s else ""
        trace_parts.append(
            f"<div class='trace-item'><div><strong>Step {int(st.get('step_index', 0))} · {html.escape(str(st.get('tool_name') or 'reasoning'))}</strong> — "
            f"{html.escape(str(st.get('title') or ''))} <span class='pill' style='margin-left:8px'>{html.escape(str(st.get('status', 'done')))} · {int(st.get('duration_ms') or 0)}ms</span></div>{th_h}{sq_h}</div>"
        )

    tokens = int(turn.get("prompt_tokens") or 0) + int(turn.get("completion_tokens") or 0)
    meta = [f"数据源: {html.escape(f'{source.name} ({source.dialect.upper()})')}", f"图表产物: {len(artifacts)}", f"推理步数: {len(steps)}", f"Tokens: {tokens}", f"导出时间: {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')}"]
    sections = [
        f"<section class='section card'><h2 class='section-title'>分析结论（Evidence-Bound）</h2><div>{_md_to_html(str(turn.get('answer_md') or ''))}</div></section>",
        f"<section class='section'><h2 class='section-title'>交互式图表与数据证据</h2><div class='bi-grid'>{''.join(art_parts)}</div></section>" if art_parts else "",
        f"<section class='section'><h2 class='section-title'>Agent 白盒推理轨迹</h2>{''.join(trace_parts)}</section>" if trace_parts else "",
    ]
    return _render_page(
        f"{q_esc} — DataPilot-Agent 分析报告", "light", f"<div><h1>{q_esc}</h1>{_pills(meta)}</div>",
        "".join(sections), "Generated by DataPilot-Agent v2.0 · Glass-Box ReAct Analytics Report", "__REPORT_CHARTS__", charts,
    )
