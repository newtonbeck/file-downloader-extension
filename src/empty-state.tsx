export function EmptyState() {
  return (
    <div className="flex flex-col gap-2 text-gray-900 items-center bg-gradient-to-b from-gray-100 to-white rounded-lg p-4">
      <img src="/empty.svg" className="w-[148px] h-[148px]" />
      <p className="text-lg font-medium text-center">
        Nothing queued yet
      </p>
      <p className="text-center">
        Open a Dropbox shared folder in a tab, then scan it from here
      </p>
    </div>
  );
}
