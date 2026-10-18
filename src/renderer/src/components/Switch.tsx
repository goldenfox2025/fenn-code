/**
 * The app's on/off toggle. Screen readers hear it as a switch with its state and a name:
 * `label` is that name (usually the setting's own label beside it).
 */
export function Switch({ on, label, onChange, tip }: { on: boolean; label: string; onChange: (on: boolean) => void; tip?: string }) {
  return (
    <button
      type="button"
      className={'switch' + (on ? ' on' : '')}
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-tip={tip}
      onClick={() => onChange(!on)}
    />
  )
}
