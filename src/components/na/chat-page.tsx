import { Logo } from './logo'
import { ChatInput } from './chat-input'
import { ChatThread } from './chat-thread'
import { RecentConversations } from './recent-conversations'
import { useChat } from '../../lib/use-chat'

/** NA 核心 AI 对话页：空态居中 Logo+输入框；有消息后转消息流+底部输入框；右侧最近对话面板 */
export default function ChatPage() {
  const chat = useChat()
  const hasMessages = chat.messages.length > 0

  return (
    <div className="flex min-w-0 flex-1">
      {/* 对话主区 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {hasMessages ? (
          <>
            <ChatThread messages={chat.messages} streaming={chat.streaming} />
            <div className="flex justify-center px-8 pb-6">
              <ChatInput
                onSend={chat.send}
                onStop={chat.stop}
                sending={chat.streaming}
                status={chat.sidecarStatus}
                attachments={chat.attachments}
                onUpload={chat.upload}
                onRemoveAttachment={chat.removeAttachment}
                uploadError={chat.uploadError}
                hasHistory={chat.messages.length > 0}
                organizeResult={chat.organizeResult}
                onDismissOrganize={chat.clearOrganizeResult}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-8 px-8">
            <Logo size={224} />
            <ChatInput
              onSend={chat.send}
              onStop={chat.stop}
              sending={chat.streaming}
              status={chat.sidecarStatus}
              attachments={chat.attachments}
              onUpload={chat.upload}
              onRemoveAttachment={chat.removeAttachment}
              uploadError={chat.uploadError}
              hasHistory={chat.messages.length > 0}
              organizeResult={chat.organizeResult}
              onDismissOrganize={chat.clearOrganizeResult}
            />
          </div>
        )}
      </div>
      {/* 右侧历史对话面板（可折叠，点击载入会话） */}
      <RecentConversations
        currentId={chat.conversationId}
        onSelect={chat.loadConversation}
        onNew={chat.startNewConversation}
      />
    </div>
  )
}
