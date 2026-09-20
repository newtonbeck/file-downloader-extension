import clsx from "clsx";

interface ButtonProps {
  type?: 'primary' | 'secondary';
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

export function Button({ type = 'primary', onClick, disabled = false, children }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx("w-full text-sm rounded-xl border px-5 py-2.5 font-medium", {
        'hover:cursor-pointer': !disabled,
        'opacity-40 cursor-not-allowed': disabled,
        'bg-gradient-to-b from-gray-900 to-black text-white border-black': type === 'primary',
        'bg-white text-gray-900 border-gray-200': type === 'secondary',
        'hover:bg-gray-50': type === 'secondary' && !disabled,
      })}
    >
      {children}
    </button>
  );
}
