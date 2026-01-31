import React from 'react';
import { useCartStore, CartItem } from '../store/cart.store.js';

interface AddToCartButtonProps {
  item: Omit<CartItem, 'quantity'>;
  children?: React.ReactNode;
}

export function AddToCartButton({ item, children }: AddToCartButtonProps) {
  const addItem = useCartStore((state) => state.addItem);

  return (
    <button
      onClick={() => addItem(item)}
      className="add-to-cart-button"
      aria-label={`添加 ${item.name} 到购物车`}
    >
      {children ?? '加入购物车'}
    </button>
  );
}
