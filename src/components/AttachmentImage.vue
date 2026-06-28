<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { db } from '@/db'

const props = defineProps<{
  hash: string
}>()

const emit = defineEmits<{ preview: [url: string] }>()

const url = ref<string | null>(null)
const loading = ref(true)

function release() {
  if (url.value) {
    URL.revokeObjectURL(url.value)
    url.value = null
  }
}

async function load() {
  release()
  loading.value = true
  const att = await db.attachments.get(props.hash)
  if (att?.blob) {
    url.value = URL.createObjectURL(att.blob)
  }
  loading.value = false
}

onMounted(load)
watch(() => props.hash, load)
onBeforeUnmount(release)
</script>

<template>
  <div class="att-img">
    <van-loading v-if="loading" size="20" />
    <img v-else-if="url" :src="url" loading="lazy" @click="emit('preview', url)" />
    <van-icon v-else name="photo-fail" color="#dcdee0" size="32" />
  </div>
</template>

<style scoped>
.att-img {
  margin: 8px 0;
  min-height: 40px;
  display: flex;
  justify-content: center;
}
.att-img img {
  max-width: 100%;
  border-radius: 8px;
  cursor: pointer;
}
</style>
