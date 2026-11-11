/** 新消息 Toast：右上角滑入，点击跳转房间。 */
import { storeToRefs } from 'pinia'
import { useGroupStore } from '../store'

export function useToast() {
  const store = useGroupStore()
  const { toasts } = storeToRefs(store)

  function open(roomId: string) {
    store.openToast({ roomId })
    return roomId
  }

  return { toasts, open }
}
