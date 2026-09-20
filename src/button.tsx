import clsx from "clsx";

interface ButtonProps {
  type?: 'primary' | 'secondary';
  onClick: () => void;
  children: React.ReactNode;
}

export function Button({ type = 'primary', onClick, children }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      className={clsx("w-full text-sm rounded-xl border px-5 py-2.5 font-medium hover:cursor-pointer", {
        'bg-gradient-to-b from-gray-900 to-black text-white': type === 'primary',
        'bg-white text-gray-900 border-gray-200 hover:bg-gray-50': type === 'secondary',
      })}
    >
      {children}
    </button>
  );
}
