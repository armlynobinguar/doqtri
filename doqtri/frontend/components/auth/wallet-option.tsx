import { ConnectWalletButton } from "@/components/auth/connect-wallet-button";
import { VarialMark } from "@/components/brand/varial-mark";

/** The wallet path on the auth screens: below email, and deliberately quiet. */
export function WalletOption({ next }: { next?: string }) {
  return (
    <>
      <div className="eyebrow my-2 flex items-center gap-3 text-[10px]">
        <span className="bg-border h-px flex-1" />
        or
        <span className="bg-border h-px flex-1" />
      </div>
      <ConnectWalletButton
        variant="ghost"
        size="lg"
        label="Use Varial wallet"
        icon={<VarialMark className="size-4" />}
        next={next}
        className="w-full rounded-full"
      />
    </>
  );
}
