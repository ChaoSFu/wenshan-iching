// 手机宽度下收窄，避免本卦、变卦并排时超出屏幕
const SIZES = {
  sm: { width: "w-14", height: "h-1.5", gap: "gap-1", yinGap: "w-2.5", label: "text-[10px] w-4" },
  md: { width: "w-20 sm:w-28", height: "h-2 sm:h-2.5", gap: "gap-1.5 sm:gap-2", yinGap: "w-3 sm:w-4", label: "text-xs w-4 sm:w-5" },
  lg: { width: "w-24 sm:w-40", height: "h-2.5 sm:h-3", gap: "gap-2 sm:gap-2.5", yinGap: "w-3.5 sm:w-5", label: "text-xs sm:text-sm w-4 sm:w-6" },
} as const;

/**
 * 卦画：上爻在上、初爻在下。阳爻实线，阴爻断线；动爻另标「动」字，不只靠颜色区分（PRD §4）。
 * revealed：起卦过程中已揭示的爻数，未揭示的位置画虚线占位。
 */
export function HexagramFigure({
  bits,
  moving = [],
  revealed = 6,
  size = "md",
  label,
}: {
  bits: readonly (0 | 1)[];
  moving?: readonly number[];
  revealed?: number;
  size?: keyof typeof SIZES;
  label: string;
}) {
  const s = SIZES[size];
  return (
    <div role="img" aria-label={label} className={`inline-flex flex-col ${s.gap}`}>
      {[5, 4, 3, 2, 1, 0].map((i) => {
        const shown = i < revealed;
        const isMoving = shown && moving.includes(i + 1);
        return (
          <div key={i} className="flex items-center gap-2">
            <div className={`flex ${s.width} ${s.height}`}>
              {!shown ? (
                <span className="h-full w-full rounded-[2px] border border-dashed border-line" />
              ) : bits[i] === 1 ? (
                <span className="h-full w-full rounded-[2px] bg-ink" />
              ) : (
                <>
                  <span className="h-full flex-1 rounded-[2px] bg-ink" />
                  <span className={s.yinGap} />
                  <span className="h-full flex-1 rounded-[2px] bg-ink" />
                </>
              )}
            </div>
            <span className={`${s.label} shrink-0 font-serif leading-none text-zhu`}>{isMoving ? "动" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}
