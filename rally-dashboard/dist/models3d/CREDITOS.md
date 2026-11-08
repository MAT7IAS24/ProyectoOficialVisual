# Créditos de los modelos 3D

Modelos descargados de Poly Pizza (poly.pizza) por el equipo. En Poly Pizza cada modelo es
CC0 (dominio público) o CC-BY (exige dar crédito). **Confirmar la licencia exacta en la página
de cada modelo** y actualizar esta tabla; mientras tanto se da crédito a todos.

| Archivo | Modelo | Autor | Página | Licencia | Uso en la web |
|---|---|---|---|---|---|
| `estadio.glb` | Football stadium | Poly by Google | https://poly.pizza/m/6TZCkGh76m5 | por confirmar (los modelos de Poly by Google suelen ser CC-BY 3.0) | Estadio alrededor del óvalo del N4 (estirado para que quepa la pista) |
| `coche.glb` | CAR Model | Ignition Labs | https://poly.pizza/m/5zUWP5UsLg- | por confirmar | Coche del N4 (el modelo representa un Lamborghini Aventador) |
| `valla.glb` | Street barrier | Boogaard53 | https://poly.pizza/m/Vdw83XGiJL | por confirmar | Vallas que frenan el coche |
| `piezas-pista.glb` | Road Bits | Kay Lousberg | https://poly.pizza/m/5BPCPOycxC | por confirmar (Kay Lousberg suele publicar en CC0) | Asfalto y paso peatonal en la salida |

Los archivos se usan sin modificar; la escala, posición y color del coche "fantasma" se ajustan en `scene-v4.js`.

## Desde el N6

| Archivo | Qué es | Autor / fuente | Licencia | Uso |
|---|---|---|---|---|
| `hdri/cielo.exr` | Foto 360° de cielo (HDRI) reducida a 512×512 | Poly Haven, vía el paquete npm `@pmndrs/assets` | CC0 | Luz ambiental y reflejos del coche (`venue.js`) |
| `coche-rally.glb` (pendiente) | "Lowpoly WRC rally car" | Amon99 · https://sketchfab.com/3d-models/lowpoly-wrc-rally-car-4330d849b2df437ca83071bc3644a6cf | CC BY 4.0 (dar crédito) | Coche del N6 en adelante; mientras no esté se usa `coche.glb` |

El estadio del N6 ya no usa `estadio.glb`: las tribunas, el público, el techo, las torres de luces, las
banderas, las vallas publicitarias (con marcas inventadas), los árboles y las colinas se construyen con código
en `venue.js`. El cielo usa el modelo de atmósfera `Sky` de three.js (licencia MIT, en `vendor/three`).
