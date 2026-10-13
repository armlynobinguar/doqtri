"use client";

import { TokenIcon } from "@/components/brand/token-icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MARKET_TOKENS } from "@/lib/stellar/market-config";

/** Picks the token a price is in, each with its badge. */
export function TokenSelect({
  value,
  onChange,
  disabled,
  className,
  "data-testid": testId,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next as string)} disabled={disabled}>
      <SelectTrigger aria-label="Token" data-testid={testId} className={className ?? "w-auto font-medium"}>
        <SelectValue>
          {(code: string) => (
            <>
              <TokenIcon code={code} className="size-5" />
              {code}
            </>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {MARKET_TOKENS.map((t) => (
          <SelectItem key={t.code} value={t.code} data-testid={`token-option-${t.code}`}>
            <TokenIcon code={t.code} className="size-5" />
            {t.code}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
