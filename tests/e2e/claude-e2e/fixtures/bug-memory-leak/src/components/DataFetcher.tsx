import { useState, useEffect } from 'react';

interface DataFetcherProps {
  url: string;
  interval?: number;
}

// Bug: 内存泄漏 - 组件卸载后定时器未清理
// Bug: 内存泄漏 - 事件监听器未移除
export function DataFetcher({ url, interval = 5000 }: DataFetcherProps) {
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await fetch(url);
        const json = await res.json();
        setData(json);
      } finally {
        setLoading(false);
      }
    };

    fetchData();

    // Bug: setInterval 返回值未保存，无法清理
    setInterval(fetchData, interval);

    // Bug: 添加事件监听但未清理
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Bug: 缺少清理函数
  }, [url, interval]);

  if (loading) return <div>Loading...</div>;
  return <div>{JSON.stringify(data)}</div>;
}
