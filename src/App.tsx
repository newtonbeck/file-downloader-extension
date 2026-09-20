import { EmptyState } from './empty-state'

function App() {
  return (
    <div className="w-full h-full p-4 flex flex-col gap-4">
      <div className="flex justify-center items-center mb-2">
        <h1 className="text-lg font-semibold">File Downloader</h1>
      </div>

      <div className="flex-1 flex flex-col gap-4 overflow-y-auto">
        <EmptyState />
      </div>
    </div>
  )
}

export default App
