import React from 'react';
import { useCartStore } from '../store/cart.store.js';

export function Cart() {
  const { items, removeItem, updateQuantity, clearCart, totalPrice } =
    useCartStore();

  if (items.length === 0) {
    return <div className="cart cart--empty">购物车为空</div>;
  }

  return (
    <div className="cart">
      <h2>购物车</h2>
      <ul className="cart__list">
        {items.map((item) => (
          <li key={item.id} className="cart__item">
            <span className="cart__item-name">{item.name}</span>
            <span className="cart__item-price">¥{item.price.toFixed(2)}</span>
            <div className="cart__item-quantity">
              <button
                onClick={() => updateQuantity(item.id, item.quantity - 1)}
                aria-label="减少数量"
              >
                -
              </button>
              <span>{item.quantity}</span>
              <button
                onClick={() => updateQuantity(item.id, item.quantity + 1)}
                aria-label="增加数量"
              >
                +
              </button>
            </div>
            <button
              onClick={() => removeItem(item.id)}
              className="cart__item-remove"
              aria-label="删除商品"
            >
              删除
            </button>
          </li>
        ))}
      </ul>
      <div className="cart__footer">
        <span className="cart__total">总价: ¥{totalPrice().toFixed(2)}</span>
        <button onClick={clearCart} className="cart__clear">
          清空购物车
        </button>
      </div>
    </div>
  );
}
