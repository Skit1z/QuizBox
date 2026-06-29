<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAdminStore } from '@/stores/admin'
import { showFailToast } from 'vant'

const props = defineProps<{
  show: boolean
}>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'verified'): void
}>()

const adminStore = useAdminStore()
const password = ref('')
const verifying = ref(false)

watch(
  () => props.show,
  (v) => {
    if (v) password.value = ''
  },
)

async function onConfirm() {
  const pwd = password.value.trim()
  if (!pwd) {
    showFailToast('请输入管理密码')
    return
  }
  verifying.value = true
  try {
    const ok = await adminStore.verify(pwd)
    if (ok) {
      emit('update:show', false)
      emit('verified')
    } else {
      showFailToast('密码错误')
    }
  } finally {
    verifying.value = false
  }
}

function onCancel() {
  emit('update:show', false)
}
</script>

<template>
  <van-dialog
    :show="show"
    title="管理员验证"
    show-cancel-button
    :confirm-button-text="verifying ? '验证中…' : '确定'"
    :before-close="
      (action: string) => {
        if (action === 'confirm') {
          onConfirm()
          return false
        }
        onCancel()
        return true
      }
    "
    @update:show="emit('update:show', $event)"
  >
    <div class="admin-dialog__body">
      <p class="admin-dialog__hint">此操作需要管理员权限，请输入管理密码</p>
      <input
        v-model="password"
        type="password"
        class="admin-dialog__input"
        placeholder="管理密码"
        autocomplete="off"
        @keyup.enter="onConfirm"
      />
    </div>
  </van-dialog>
</template>

<style scoped>
.admin-dialog__body {
  padding: var(--sp-4) var(--sp-5);
}
.admin-dialog__hint {
  font-size: 13px;
  color: var(--text-3);
  margin: 0 0 var(--sp-3);
  line-height: 1.5;
}
.admin-dialog__input {
  width: 100%;
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.admin-dialog__input:focus {
  border-color: var(--brand);
}
</style>
